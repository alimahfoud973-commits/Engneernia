import { headers } from 'next/headers';

/**
 * A structured-data block, carrying the response's CSP nonce.
 *
 * WHY THE NONCE. `src/proxy.ts` sends a Content-Security-Policy whose
 * script-src admits nothing but the nonce it minted for this response. A
 * `<script type="application/ld+json">` holds data and is never executed, so
 * browsers treat it as a data block rather than a script — but the nonce costs
 * nothing, and a policy that a future stricter browser applies to every
 * `<script>` element would otherwise silently drop the structured data with no
 * visible symptom anywhere except a search console weeks later.
 *
 * `JSON.stringify` is the escaping: the only sequence that could break out of
 * a script element is `</script>`, and the forward slash is replaced so that
 * an engineer who types it into a product description cannot end the block.
 */
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // The content is a JSON string this server just produced, with every
      // '<' escaped — there is no path by which markup reaches the page.
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
