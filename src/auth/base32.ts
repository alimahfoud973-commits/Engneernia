import { ValidationError } from '@/lib/errors';

/**
 * RFC 4648 base32, the encoding authenticator apps expect for TOTP secrets.
 * Implemented here rather than pulled in as a dependency: it is thirty lines,
 * fully specified, and sits on the authentication path where every added
 * dependency is added supply-chain risk.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Uint8Array, options: { pad?: boolean } = {}): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  if (options.pad !== false) {
    while (output.length % 8 !== 0) output += '=';
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  if (cleaned.length === 0) {
    throw new ValidationError('Base32 input is empty');
  }

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new ValidationError('Invalid base32 character', { char });
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}
