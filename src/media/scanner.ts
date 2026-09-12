import 'server-only';
import { connect } from 'node:net';

/**
 * ===========================================================================
 * MALWARE SCANNING (specification §36)
 * ===========================================================================
 * The platform accepts archives, Revit models and CAD drawings from
 * contributors and hands them to paying customers. That is a file-delivery
 * service, and a file-delivery service that does not scan is a distribution
 * channel for whatever lands in it.
 *
 * The design choice worth stating: a deployment with no scanner configured
 * does NOT record files as clean. It records SKIPPED, and the publication
 * gate refuses to publish a SKIPPED file in production. An unscanned file can
 * sit in storage; it cannot reach a customer while pretending to be checked.
 * ===========================================================================
 */

/**
 * Mirrors the database enum exactly, PENDING included. Leaving PENDING out
 * of this union would let a not-yet-scanned file slip past `isServable`
 * through a widening cast.
 */
export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'FAILED';

/** What a scanner can conclude. PENDING is a database state, not a verdict. */
export type ScanOutcome = Exclude<ScanStatus, 'PENDING'>;

export interface ScanVerdict {
  readonly status: ScanOutcome;
  readonly detail: string | null;
  readonly scanner: string;
}

export interface ScannerPort {
  readonly name: string;
  scan(body: Uint8Array): Promise<ScanVerdict>;
}

/**
 * ClamAV over the clamd INSTREAM protocol.
 *
 * Spoken directly rather than through a client library: the protocol is a
 * length-prefixed stream and a one-line reply, and the scanning path is not
 * where an extra dependency earns its risk.
 */
export class ClamAvScanner implements ScannerPort {
  readonly name = 'clamav';
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(host: string, port = 3310, timeoutMs = 120_000) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  async scan(body: Uint8Array): Promise<ScanVerdict> {
    try {
      const reply = await this.instream(body);

      if (/\bOK\s*$/.test(reply)) {
        return { status: 'CLEAN', detail: null, scanner: this.name };
      }
      if (/FOUND\s*$/.test(reply)) {
        const signature = reply.replace(/^stream:\s*/, '').replace(/\s*FOUND\s*$/, '');
        return { status: 'INFECTED', detail: signature, scanner: this.name };
      }
      return { status: 'FAILED', detail: reply.slice(0, 200), scanner: this.name };
    } catch (error) {
      // A scanner that is unreachable is a FAILURE, never an implicit pass.
      return {
        status: 'FAILED',
        detail: (error as Error).message.slice(0, 200),
        scanner: this.name,
      };
    }
  }

  private instream(body: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];

      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        reject(new Error('clamd timed out'));
      });
      socket.on('error', reject);
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        // Chunked as <4-byte big-endian length><data>, terminated by a zero length.
        const CHUNK = 64 * 1024;
        for (let offset = 0; offset < body.byteLength; offset += CHUNK) {
          const slice = body.subarray(offset, Math.min(offset + CHUNK, body.byteLength));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(slice.byteLength);
          socket.write(header);
          socket.write(slice);
        }
        socket.write(Buffer.from([0, 0, 0, 0]));
      });
    });
  }
}

/**
 * Used when no scanner is configured. It is deliberately not called a
 * "null scanner" or made to return CLEAN: it returns SKIPPED so the state is
 * visible in the database, in the admin console and to the publication gate.
 */
export class UnconfiguredScanner implements ScannerPort {
  readonly name = 'none';

  async scan(): Promise<ScanVerdict> {
    return {
      status: 'SKIPPED',
      detail: 'لم يُضبط فاحص برمجيات خبيثة لهذه البيئة',
      scanner: this.name,
    };
  }
}

let cached: ScannerPort | undefined;

/**
 * MALWARE_SCANNER selects the adapter. "none" must be written out explicitly,
 * so that running without scanning is a decision somebody made and can be
 * found in the configuration, rather than a default nobody noticed.
 */
export function getScanner(): ScannerPort {
  if (cached) return cached;

  const setting = (process.env.MALWARE_SCANNER ?? 'none').trim().toLowerCase();

  if (setting === 'clamav') {
    const host = process.env.CLAMAV_HOST ?? '127.0.0.1';
    const port = Number(process.env.CLAMAV_PORT ?? 3310);
    cached = new ClamAvScanner(host, port);
    return cached;
  }

  cached = new UnconfiguredScanner();
  return cached;
}

export function resetScannerForTests(): void {
  cached = undefined;
}

/**
 * May a file in this scan state be served?
 *
 *   CLEAN    — always.
 *   SKIPPED  — outside production only, where no scanner is configured.
 *   PENDING  — never: it has not been looked at yet.
 *   INFECTED — never.
 *   FAILED   — never; a scanner that could not finish is not a pass.
 */
export function isServable(status: ScanStatus, isProduction: boolean): boolean {
  if (status === 'CLEAN') return true;
  if (status === 'SKIPPED') return !isProduction;
  return false;
}
