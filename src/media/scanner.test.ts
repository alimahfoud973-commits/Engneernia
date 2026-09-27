import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ClamAvScanner, UnconfiguredScanner, clamdReply, isServable, type ScanStatus } from './scanner';

/**
 * ===========================================================================
 * THE GATE BETWEEN AN UNSCANNED FILE AND A CUSTOMER
 * ===========================================================================
 * This module had no test of any kind, and it owns two claims the platform
 * rests on: that a file which was never scanned cannot be served in
 * production, and that a scanner which is unreachable fails rather than
 * quietly passing. Both are one boolean away from being false, and neither
 * would announce itself — an implicit pass looks exactly like a clean scan.
 * ===========================================================================
 */

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

/** A fake clamd that replies with whatever the test wants, and records what it got. */
async function fakeClamd(reply: string | null, terminator = '\n'): Promise<{ port: number; received: () => Buffer }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
    if (reply === null) return; // connect, say nothing, let the timeout bite
    socket.on('data', () => {});
    setTimeout(() => socket.end(`${reply}${terminator}`), 30);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, received: () => Buffer.concat(chunks) };
}

describe('isServable', () => {
  const ALL: ScanStatus[] = ['PENDING', 'CLEAN', 'INFECTED', 'SKIPPED', 'FAILED'];

  it.each(ALL)('%s — in production, only CLEAN is servable', (status) => {
    expect(isServable(status, true)).toBe(status === 'CLEAN');
  });

  it.each(ALL)('%s — outside production, CLEAN and SKIPPED are servable', (status) => {
    expect(isServable(status, false)).toBe(status === 'CLEAN' || status === 'SKIPPED');
  });

  it('never serves a file that was never looked at', () => {
    // PENDING is the state a row holds between upload and verdict. Serving it
    // would mean handing over a file the platform has not yet examined.
    expect(isServable('PENDING', false)).toBe(false);
    expect(isServable('PENDING', true)).toBe(false);
  });

  it('never serves a file whose scan failed', () => {
    // A scan that could not finish is not a pass. This is the state an
    // unreachable scanner produces, so treating it as servable would turn
    // "the scanner is down" into "everything is clean".
    expect(isServable('FAILED', false)).toBe(false);
    expect(isServable('FAILED', true)).toBe(false);
  });
});

describe('UnconfiguredScanner', () => {
  it('reports SKIPPED, never CLEAN', async () => {
    // The distinction the whole design rests on: no scanner means "not
    // checked", recorded as such, and refused in production by isServable.
    const verdict = await new UnconfiguredScanner().scan();
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.status).not.toBe('CLEAN');
    expect(verdict.scanner).toBe('none');
  });
});

describe('ClamAvScanner', () => {
  it('reads a clean verdict', async () => {
    const { port } = await fakeClamd('stream: OK');
    const verdict = await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('harmless'));
    expect(verdict.status).toBe('CLEAN');
    expect(verdict.detail).toBeNull();
  });

  it('reads an infection and keeps the signature name', async () => {
    // The signature is what tells the owner what was found, so it has to
    // survive the parse rather than be flattened into "infected".
    const { port } = await fakeClamd('stream: Eicar-Test-Signature FOUND');
    const verdict = await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('x'));
    expect(verdict.status).toBe('INFECTED');
    expect(verdict.detail).toBe('Eicar-Test-Signature');
  });

  it('treats an answer it does not understand as a failure, not a pass', async () => {
    const { port } = await fakeClamd('ERROR: something went wrong');
    const verdict = await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('x'));
    expect(verdict.status).toBe('FAILED');
  });

  it('FAILS when the scanner is unreachable, and never returns CLEAN', async () => {
    /**
     * The claim in the module's own comment, which nothing checked. On launch
     * day a mistyped CLAMAV_HOST is the likeliest state of the world, and the
     * difference between FAILED and CLEAN here is the difference between "no
     * file is published" and "every file is published unscanned".
     */
    // Port 1 on loopback: nothing listens, and connecting is refused at once.
    const verdict = await new ClamAvScanner('127.0.0.1', 1).scan(Buffer.from('x'));
    expect(verdict.status).toBe('FAILED');
    expect(verdict.status).not.toBe('CLEAN');
    expect(verdict.detail).toBeTruthy();
  });

  it('FAILS on a scanner that accepts the connection and then never answers', async () => {
    // Worse than a refused connection, because it looks alive. The timeout is
    // shortened here; in production it is two minutes.
    const { port } = await fakeClamd(null);
    const verdict = await new ClamAvScanner('127.0.0.1', port, 150).scan(Buffer.from('x'));
    expect(verdict.status).toBe('FAILED');
    expect(verdict.detail).toContain('timed out');
  });

  it('sends the whole file, in correctly framed chunks', async () => {
    /**
     * The INSTREAM protocol is spoken directly here rather than through a
     * client library, so the framing is this repository's to get right. A file
     * larger than one 64 KB chunk is the case that would expose a mistake —
     * and a partially transmitted file scans clean, which is the worst
     * possible way for this to be wrong.
     */
    const body = Buffer.alloc(150_000);
    for (let i = 0; i < body.length; i += 1) body[i] = i % 251;

    const { port, received } = await fakeClamd('stream: OK');
    await new ClamAvScanner('127.0.0.1', port).scan(body);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const wire = received();
    expect(wire.subarray(0, 10).toString()).toBe('zINSTREAM\0');

    // Walk the frames back out and reassemble.
    const reassembled: Buffer[] = [];
    let offset = 10;
    for (;;) {
      const length = wire.readUInt32BE(offset);
      offset += 4;
      if (length === 0) break;
      reassembled.push(wire.subarray(offset, offset + length));
      offset += length;
    }

    expect(Buffer.concat(reassembled).equals(body)).toBe(true);
    expect(offset).toBe(wire.length);
  });
});

/**
 * WHAT A REAL CLAMD SENDS (Stage 4, S4-02).
 *
 * The adapter sends `zINSTREAM`, and clamd answers a z-prefixed command with a
 * NUL-terminated reply. The fake above used to end every reply with a newline,
 * so all of these passed while every real scan was recorded as FAILED — the
 * audit proved it against the protocol, not against this file.
 */
describe('ClamAvScanner — the NUL-terminated replies of a real clamd', () => {
  it('reads "stream: OK\\0" as CLEAN', async () => {
    const { port } = await fakeClamd('stream: OK', '\0');
    const verdict = await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('harmless'));
    expect(verdict).toMatchObject({ status: 'CLEAN', detail: null });
  });

  it('reads "stream: <sig> FOUND\\0" as INFECTED with the signature', async () => {
    const { port } = await fakeClamd('stream: Eicar-Test-Signature FOUND', '\0');
    const verdict = await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('x'));
    expect(verdict).toMatchObject({ status: 'INFECTED', detail: 'Eicar-Test-Signature' });
  });

  it('keeps an error reply a FAILURE — never CLEAN', async () => {
    const { port } = await fakeClamd('INSTREAM size limit exceeded. ERROR', '\0');
    const verdict = await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('x'));
    expect(verdict.status).toBe('FAILED');
    expect(verdict.detail).toBe('INSTREAM size limit exceeded. ERROR');
  });

  it('keeps an unknown reply a FAILURE', async () => {
    const { port } = await fakeClamd('something else', '\0');
    expect((await new ClamAvScanner('127.0.0.1', port).scan(Buffer.from('x'))).status).toBe('FAILED');
  });
});

describe('clamdReply — removes the terminator and nothing else', () => {
  it.each([
    ['stream: OK\0', 'stream: OK'],
    ['stream: OK\n', 'stream: OK'],
    ['stream: OK', 'stream: OK'],
    ['stream: X FOUND\0\0', 'stream: X FOUND'],
  ])('%j → %j', (raw, expected) => {
    expect(clamdReply(Buffer.from(raw))).toBe(expected);
  });

  it('does not turn a NUL in the middle into a clean verdict', () => {
    // "OK" followed by more bytes is not an OK reply.
    expect(/\bOK\s*$/.test(clamdReply(Buffer.from('stream: OK\0garbage')))).toBe(false);
  });
});
