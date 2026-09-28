import { describe, it, expect } from 'vitest';
import { normalizePhone } from './phone';

/**
 * The one stored form of a subscriber's phone (Stage 6). The same rule runs
 * in the form, the server action and the sign-in path; the database refuses
 * anything else (`users_phone_e164`).
 */
describe('normalizePhone', () => {
  it.each([
    ['+963933123456', '+963933123456'],
    ['00963933123456', '+963933123456'],
    ['+963 933 123 456', '+963933123456'],
    ['+963-933-123-456', '+963933123456'],
    ['(+963) 933.123.456', '+963933123456'],
    ['٠٠٩٦٣٩٣٣١٢٣٤٥٦', '+963933123456'],
    ['+٩٦٣ ٩٣٣ ١٢٣ ٤٥٦', '+963933123456'],
    ['۰۰۹۶۶۵۰۱۲۳۴۵۶۷', '+966501234567'],
    ['⁦+963933123456⁩', '+963933123456'],
    ['+963 933123456', '+963933123456'],
  ])('reads %j as %s', (typed, stored) => {
    expect(normalizePhone(typed)).toBe(stored);
  });

  it.each([
    ['a local number — no country is assumed', '0933123456'],
    ['digits with no international prefix', '963933123456'],
    ['a country code starting with 0', '+0963933123456'],
    ['too short for any country', '+9631234'],
    ['longer than E.164 allows', '+9639331234567890'],
    ['letters', '+963abc123456'],
    ['a plus in the middle', '963+933123456'],
    ['nothing', ''],
  ])('refuses %s', (_label, typed) => {
    expect(normalizePhone(typed)).toBeNull();
  });
});
