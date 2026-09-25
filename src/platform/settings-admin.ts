import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { settings } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { normalizeWhatsappNumber } from '@/payments/whatsapp';

/**
 * ===========================================================================
 * THE OWNER'S SETTINGS — the WhatsApp number only (specification §23; W2)
 * ===========================================================================
 * Until now `support.whatsapp` could be changed only from a database console,
 * with no check on what was typed and no record that it changed. Here the
 * owner sets it; it is validated and stored exactly as wa.me needs it, and
 * the change is written to the audit log in the transaction that makes it.
 *
 * OWNER-ONLY at every layer: the page calls `requireOwner`, each function
 * refuses anyone else, and `settings_write` (0017) admits only
 * `app_is_owner()`.
 *
 * Only the value moves. `is_public` stays what it is — the number is shown to
 * buyers by design — and no other setting is reachable from here.
 * ===========================================================================
 */

const WHATSAPP_KEY = 'support.whatsapp';

function assertOwner(actor: Actor): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError('تعديل إعدادات المنصة من صلاحية مالك المنصة وحده');
  }
}

/** The stored value as a string. Read as text: see `getPublicSettings` on why (W2). */
async function readNumber(tx: Transaction): Promise<string | null> {
  const [row] = await tx
    .select({ json: sql<string>`${settings.value}::text` })
    .from(settings)
    .where(eq(settings.key, WHATSAPP_KEY))
    .limit(1);
  if (!row) return null;
  const value = JSON.parse(row.json) as unknown;
  return typeof value === 'string' ? value : String(value);
}

/** What the screen shows: the stored number, and whether checkout can use it. */
export async function whatsappSettingForOwner(
  actor: Actor,
): Promise<{ readonly number: string; readonly usable: boolean }> {
  assertOwner(actor);
  const stored = (await withActor(actor, readNumber)) ?? '';
  return { number: stored, usable: normalizeWhatsappNumber(stored) !== null };
}

/**
 * Set the WhatsApp number, or clear it with an empty value — which is how the
 * owner turns WhatsApp assistance off. Anything else must be a number in
 * international form; it is stored as digits only ("963933123456").
 */
export async function updateWhatsappNumber(
  actor: Actor,
  raw: string,
): Promise<{ readonly changed: boolean; readonly number: string }> {
  assertOwner(actor);
  if (actor.kind !== 'USER') throw new RuleViolationError('تعديل إعدادات المنصة من صلاحية مالك المنصة وحده');

  let next = '';
  if (raw.trim() !== '') {
    const normalized = normalizeWhatsappNumber(raw);
    if (normalized === null) {
      throw new ValidationError(
        'أدخل رقم واتساب بالصيغة الدولية مع رمز الدولة، مثل ⁦+963 933 123 456⁩ — الرقم المحلي الذي يبدأ بصفر لا يصلح',
      );
    }
    next = normalized;
  }

  return withActor(actor, async (tx) => {
    const before = await readNumber(tx);
    if (before === next) return { changed: false, number: next };

    const value = sql`to_jsonb(${next}::text)`;
    const updated = await tx
      .update(settings)
      .set({ value, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(settings.key, WHATSAPP_KEY))
      .returning({ key: settings.key });

    if (updated.length === 0) {
      // 0017 creates the row everywhere; should it be missing, it is created
      // public — the number exists to be shown to buyers.
      const inserted = await tx
        .insert(settings)
        .values({
          key: WHATSAPP_KEY, value, isPublic: true, updatedBy: actor.userId,
          descriptionAr: 'رقم واتساب للمساعدة في الدفع',
        })
        .returning({ key: settings.key });
      if (inserted.length === 0) throw new RuleViolationError('لم يُحفظ رقم واتساب');
    }

    await recordAudit(tx, actor, {
      action: 'SETTINGS_CHANGED',
      entityType: 'setting',
      entityId: WHATSAPP_KEY,
      before: { value: before },
      after: { value: next },
    });
    return { changed: true, number: next };
  });
}
