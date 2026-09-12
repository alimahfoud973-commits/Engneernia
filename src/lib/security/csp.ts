/**
 * ===========================================================================
 * CONTENT SECURITY POLICY
 * ===========================================================================
 * Until P8 this file did not exist, and `next.config.ts` carried a comment
 * claiming that "scripts use nonces in production (see middleware, phase P1)".
 * That was never true: no CSP header was ever sent for an HTML page. The
 * comment is the more dangerous half of the defect — a reviewer reading the
 * config would have ticked CSP off the list without checking.
 *
 * WHAT A CSP IS WORTH HERE. The platform renders contributor-supplied text
 * (product titles, descriptions, display names) and owner-supplied text
 * (adjustment notes) into pages that also show financial figures. React
 * escapes all of it, and nothing on the site calls `dangerouslySetInnerHTML`
 * — so a CSP is the SECOND line, not the first. It exists for the day a third
 * line of markup slips past the first one.
 *
 * WHY NONCES AND NOT `'unsafe-inline'`. Next streams its own inline scripts
 * (the RSC flight payload, the hydration bootstrap) into every page, so a
 * policy that forbids inline scripts outright breaks the site. The two ways
 * out are opposites: allow ALL inline scripts, which concedes exactly the
 * attack CSP is meant to stop, or mint a per-response random nonce that the
 * framework stamps on its own scripts and an injected one cannot guess. Next
 * reads the nonce out of the `Content-Security-Policy` REQUEST header, which
 * is why `proxy.ts` sets it on the request as well as the response.
 *
 * `'strict-dynamic'` then lets those nonce-carrying bootstrap scripts load the
 * application's own chunks without every chunk URL having to be listed. Under
 * `'strict-dynamic'` a CSP3 browser IGNORES `'self'` and any host in
 * script-src; `'self'` is kept only for older browsers that ignore
 * `'strict-dynamic'` instead, and the two groups are covered by the same line.
 * ===========================================================================
 */

/** Fresh per response. 128 bits, base64 — guessing it is not a strategy. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy for an HTML response.
 *
 * `isDevelopment` relaxes exactly two things, and only two: `'unsafe-eval'`,
 * which Next's hot-reload runtime requires, and a websocket connection for
 * that reload channel. Production gets neither. The split is here, in one
 * expression, so that what production actually sends can be read in one place
 * rather than inferred from a chain of conditions.
 */
export function buildCsp(nonce: string, isDevelopment: boolean): string {
  const directives: Array<[string, string]> = [
    // Nothing loads from anywhere unless a directive below says otherwise.
    ['default-src', "'self'"],
    [
      'script-src',
      `'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    ],
    /**
     * Styles keep `'unsafe-inline'`.
     *
     * Next injects the critical stylesheet inline while streaming, and a style
     * nonce is not threaded through that path. The concession is real but
     * small: CSS injection can restyle a page, it cannot execute script here,
     * because script-src is nonce-gated independently.
     */
    ['style-src', "'self' 'unsafe-inline'"],
    ['img-src', "'self' data: blob:"],
    ['font-src', "'self' data:"],
    ['connect-src', isDevelopment ? "'self' ws: wss:" : "'self'"],
    /**
     * The product page shows a PDF preview in an iframe served from this
     * origin (/api/files/<slug>/PREVIEW), so frames from 'self' are allowed —
     * and nothing else is.
     */
    ['frame-src', "'self'"],
    // No plugins, ever.
    ['object-src', "'none'"],
    /**
     * `base-uri 'none'` matters more than it looks. A single injected <base>
     * tag silently repoints every relative script URL on the page at an
     * attacker's host, which is a way around `'strict-dynamic'`.
     */
    ['base-uri', "'none'"],
    /**
     * Where a form may POST. Every form on this site posts to a server action
     * on this origin; an injected form that posts credentials or an adjustment
     * elsewhere is refused by the browser.
     */
    ['form-action', "'self'"],
    // Clickjacking, in the modern spelling. X-Frame-Options stays for old UAs.
    ['frame-ancestors', "'none'"],
    ['upgrade-insecure-requests', ''],
  ];

  return directives
    .map(([name, value]) => (value ? `${name} ${value}` : name))
    .join('; ');
}
