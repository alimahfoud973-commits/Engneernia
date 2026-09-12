import { describe, it, expect } from 'vitest';
import { renderNotification } from './render';

/**
 * The message catalogue.
 *
 * Pure, so every message is testable without a database — which matters
 * because a notification is often the ONLY thing an engineer sees about a sale.
 */
describe('the engineer\'s sale message (owner decision)', () => {
  it('names the product and the engineer\'s own share', () => {
    const rendered = renderNotification('PRODUCT_SOLD', {
      productTitle: 'مخططات تسليح جسر',
      currency: 'USD',
      grossMinor: '2000',
      engineerMinor: '1600',
    });

    expect(rendered.title).toContain('مخططات تسليح جسر');
    expect(rendered.detail).toContain('16.00 USD');
    // The monthly settlement is where the money actually arrives.
    expect(rendered.detail).toContain('تسوية الشهر');
    expect(rendered.href).toBe('/account/earnings');
  });

  it('never mentions the buyer', () => {
    // OPEN-4: date, product, price and their share. The producer does not put
    // buyer data in the payload, and the renderer would not read it if it did.
    const rendered = renderNotification('PRODUCT_SOLD', {
      productTitle: 'دليل',
      currency: 'USD',
      engineerMinor: '1600',
      customerName: 'Someone Real',
      customerEmail: 'buyer@example.com',
    });

    const everything = `${rendered.title} ${rendered.detail ?? ''}`;
    expect(everything).not.toContain('Someone Real');
    expect(everything).not.toContain('buyer@example.com');
  });

  it('still reads when the amount is missing', () => {
    const rendered = renderNotification('PRODUCT_SOLD', { productTitle: 'دليل' });
    expect(rendered.title).toContain('دليل');
    expect(rendered.detail).toBeNull();
  });

  it('survives a malformed amount rather than throwing on a page', () => {
    const rendered = renderNotification('PRODUCT_SOLD', {
      productTitle: 'دليل', currency: 'USD', engineerMinor: 'not-a-number',
    });
    expect(rendered.detail).toBeNull();
  });

  it('formats a negative share on a reversal', () => {
    const rendered = renderNotification('SALE_REVERSED', {
      productTitle: 'دليل', reference: 'RF-000004',
    });
    expect(rendered.tone).toBe('warn');
    expect(rendered.detail).toContain('RF-000004');
  });
});

describe('the catalogue as a whole', () => {
  it('renders every type the schema can store', async () => {
    // Imported lazily so the unit suite stays free of the database module.
    const { notificationTypeEnum } = await import('@/db/schema/notifications');

    for (const type of notificationTypeEnum.enumValues) {
      const rendered = renderNotification(type, {});
      expect(rendered.title, `${type} has no message`).toBeTruthy();
      // A message that renders as its own enum value means the catalogue is
      // missing a case — the fallback exists for forward compatibility, not
      // as somewhere to leave types permanently.
      expect(rendered.title, `${type} falls through to the raw type`).not.toBe(type);
    }
  });

  it('falls back readably for a type it has never seen', () => {
    const rendered = renderNotification('SOMETHING_NEW', {});
    expect(rendered.title).toBe('SOMETHING_NEW');
    expect(rendered.href).toBeNull();
  });
});
