'use client';

/**
 * Root error boundary.
 *
 * Present because the application's root layout lives under `[locale]`, so
 * Next has no unscoped layout to render a root-level failure into. It must be
 * a Client Component and must render its own <html> and <body>, because it
 * REPLACES the root layout rather than nesting inside it.
 *
 * Deliberately free of event handlers. Next prerenders `/_global-error` at
 * build time, and an interactive handler here (a "try again" button calling
 * `reset`) made that prerender fail with a null React context — a build that
 * breaks because of the error page is worse than an error page without a
 * retry button. Recovery is a plain link, which needs no client runtime.
 *
 * The message is generic on purpose: an unexpected server error must not leak
 * a stack trace, a query, or a storage key to whoever triggered it.
 */
export default function GlobalError() {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          background: '#f5f7f7',
          color: '#121a1b',
        }}
      >
        <main
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <div style={{ maxWidth: '32rem', display: 'grid', gap: '12px' }}>
            <h1 style={{ fontSize: '1.5rem', margin: 0 }}>حدث خطأ غير متوقع</h1>
            <p style={{ color: '#556061', margin: 0, lineHeight: 1.7 }}>
              تعذّر إكمال الطلب. تم تسجيل الخطأ وسنعمل على معالجته.
            </p>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the
                router is not available inside a root error boundary; a plain
                anchor is the only reliable way back. */}
            <a
              href="/"
              style={{
                justifySelf: 'center',
                marginTop: '8px',
                padding: '10px 20px',
                borderRadius: '4px',
                background: '#12655c',
                color: '#fff',
                fontSize: '0.95rem',
                textDecoration: 'none',
              }}
            >
              العودة إلى الصفحة الرئيسية
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
