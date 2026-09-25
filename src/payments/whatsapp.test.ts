import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WHATSAPP_TEMPLATE, fillWhatsappTemplate, formatMajor, normalizeWhatsappNumber, whatsappLink,
} from './whatsapp';

/**
 * The WhatsApp number rule (W2). wa.me reaches a chat only with the full
 * international number in digits — no "+", no "00", no local trunk "0".
 */
describe('normalizeWhatsappNumber', () => {
  it.each([
    ['+963 933 123 456', '963933123456'],
    ['+963-933-123-456', '963933123456'],
    ['(+963) 933.123.456', '963933123456'],
    ['00963933123456', '963933123456'],
    ['963933123456', '963933123456'],
    ['+٩٦٣٩٣٣١٢٣٤٥٦', '963933123456'],
    ['‎+966 50 123 4567', '966501234567'],
  ])('accepts %s as %s', (raw, expected) => {
    expect(normalizeWhatsappNumber(raw)).toBe(expected);
  });

  it.each([
    ['0933123456', 'a local number with no country code'],
    ['', 'nothing'],
    ['call us', 'words'],
    ['+963 93', 'too short'],
    ['+1234567890123456', 'longer than E.164 allows'],
    ['+0963933123456', 'a country code cannot start with 0'],
    ['963-933-12a-456', 'a letter inside'],
  ])('refuses %s (%s)', (raw) => {
    expect(normalizeWhatsappNumber(raw)).toBeNull();
  });
});

describe('the message', () => {
  const values = { items: ['دليل أ', 'جدول ب'], order: 'EN-2026-000001', amountMinor: 2550n, currency: 'USD' };

  it('fills every placeholder, every time it appears', () => {
    expect(fillWhatsappTemplate('طلب {{order}} — أكرر: {{order}}', values))
      .toBe('طلب EN-2026-000001 — أكرر: EN-2026-000001');
  });

  it('fills the default template completely', () => {
    const message = fillWhatsappTemplate(DEFAULT_WHATSAPP_TEMPLATE, values);
    expect(message).toContain('دليل أ، جدول ب');
    expect(message).toContain('EN-2026-000001');
    expect(message).toContain('25.50 USD');
    expect(message).not.toMatch(/\{\{/);
  });

  it('formats minor units with two decimals', () => {
    expect(formatMajor(2500n)).toBe('25.00');
    expect(formatMajor(5n)).toBe('0.05');
  });

  it('encodes the message into the link, so it cannot break out of it', () => {
    const link = whatsappLink('963933123456', 'a&b=c #d');
    expect(link).toBe('https://wa.me/963933123456?text=a%26b%3Dc%20%23d');
  });
});
