import 'server-only';
import type { EmailMessage } from './port';

/**
 * The messages the registration path sends.
 *
 * Plain, Arabic, right-to-left, and deliberately without an image or a
 * tracking pixel: a verification mail that renders as a broken box in a text
 * client is a customer who cannot buy, and the platform has nothing to learn
 * from whether the message was opened.
 *
 * Every one of them carries the address it was sent to and a line saying what
 * to do if it was not requested. That line is not politeness — it is what
 * turns an unexpected mail from "somebody has my account" into "somebody
 * mistyped their address".
 */

/**
 * Escape before interpolation. NOT optional here.
 *
 * `displayName` is whatever the person typed into the registration form, and
 * it is rendered inside an HTML mail that carries the platform's name. Left
 * raw, a display name of `<a href="...">` composes a convincing phishing link
 * into a message the recipient has every reason to trust — the mail really is
 * from us. Mail clients strip <script>, which is exactly what makes this the
 * kind of hole that survives a casual test.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DIRECTION_WRAPPER = (body: string) => `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f6f6f4;font-family:system-ui,'Segoe UI',Tahoma,sans-serif;color:#1a1a18">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e4df;border-radius:12px;padding:28px;line-height:1.9">
${body}
</div>
</body></html>`;

function link(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${esc(url)}"
    style="display:inline-block;background:#111110;color:#f7d774;text-decoration:none;
           padding:12px 22px;border-radius:10px;font-weight:700">${esc(label)}</a></p>
  <p style="margin:0;font-size:13px;color:#6b6a65">أو انسخ هذا العنوان إلى متصفحك:</p>
  <p style="margin:4px 0 0;font-size:13px;word-break:break-all" dir="ltr">${esc(url)}</p>`;
}

export function verificationEmail(input: {
  readonly to: string;
  readonly displayName: string;
  readonly url: string;
  readonly platformName: string;
  readonly expiresInHours: number;
}): EmailMessage {
  const subject = `تأكيد بريدك الإلكتروني — ${input.platformName}`;
  const text = [
    `مرحباً ${input.displayName}،`,
    '',
    `أُنشئ حساب على ${input.platformName} بهذا العنوان. افتح الرابط التالي لتأكيده:`,
    input.url,
    '',
    `الرابط صالح ${input.expiresInHours} ساعة، ويعمل مرة واحدة.`,
    '',
    'إن لم تطلب هذا الحساب فتجاهل هذه الرسالة — لن يُفعَّل أي حساب دون فتح الرابط.',
  ].join('\n');

  const html = DIRECTION_WRAPPER(`
    <p style="margin:0 0 12px">مرحباً <strong>${esc(input.displayName)}</strong>،</p>
    <p style="margin:0">أُنشئ حساب على <strong>${esc(input.platformName)}</strong> بهذا العنوان
      (<span dir="ltr">${esc(input.to)}</span>). افتح الرابط لتأكيده.</p>
    ${link(input.url, 'تأكيد البريد')}
    <p style="margin:20px 0 0;font-size:13px;color:#6b6a65">
      الرابط صالح ${input.expiresInHours} ساعة، ويعمل مرة واحدة.</p>
    <p style="margin:8px 0 0;font-size:13px;color:#6b6a65">
      إن لم تطلب هذا الحساب فتجاهل هذه الرسالة — لن يُفعَّل أي حساب دون فتح الرابط.</p>`);

  return { to: input.to, subject, text, html };
}

/**
 * Sent when somebody registers with an address that ALREADY has a verified
 * account.
 *
 * The form cannot say so — that would turn it into a way to test which
 * addresses are customers here. But the person who owns the address is
 * entitled to know somebody tried, and if it was them, to be reminded that
 * signing in is what they wanted. This is the whole reason the registration
 * function distinguishes ALREADY_VERIFIED instead of silently doing nothing.
 */
export function accountAlreadyExistsEmail(input: {
  readonly to: string;
  readonly displayName: string;
  readonly signInUrl: string;
  readonly platformName: string;
}): EmailMessage {
  const subject = `محاولة إنشاء حساب بعنوانك — ${input.platformName}`;
  const text = [
    `مرحباً ${input.displayName}،`,
    '',
    `حاول أحدهم إنشاء حساب على ${input.platformName} بعنوانك، ولك حساب مؤكَّد بالفعل.`,
    'لم يتغيّر شيء في حسابك، ولم تُغيَّر كلمة مرورك.',
    '',
    `للدخول: ${input.signInUrl}`,
    '',
    'إن كنتَ أنت من حاول ونسيتَ كلمة المرور، فاطلب إعادة تعيينها من صفحة الدخول.',
    'وإن لم تكن أنت، فلا إجراء مطلوب — العنوان لم يُستعمل لإنشاء أي حساب جديد.',
  ].join('\n');

  const html = DIRECTION_WRAPPER(`
    <p style="margin:0 0 12px">مرحباً <strong>${esc(input.displayName)}</strong>،</p>
    <p style="margin:0">حاول أحدهم إنشاء حساب على <strong>${esc(input.platformName)}</strong>
      بعنوانك (<span dir="ltr">${esc(input.to)}</span>)، ولك حساب مؤكَّد بالفعل.
      <strong>لم يتغيّر شيء في حسابك، ولم تُغيَّر كلمة مرورك.</strong></p>
    ${link(input.signInUrl, 'الدخول إلى حسابك')}
    <p style="margin:20px 0 0;font-size:13px;color:#6b6a65">
      إن لم تكن أنت، فلا إجراء مطلوب — العنوان لم يُستعمل لإنشاء أي حساب جديد.</p>`);

  return { to: input.to, subject, text, html };
}
