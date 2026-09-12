'use client';

/**
 * Root error boundary.
 *
 * Required explicitly because the application's root layout lives under
 * `[locale]`, so Next has no unscoped layout to render a global failure into.
 *
 * It shows a correlation-free generic message: an unexpected server error must
 * not leak a stack trace, a query or a storage key to whoever triggered it.
 */
export default function GlobalError(_props: { error: Error; reset: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#f5f7f7',
          color: '#121a1b',
          fontFamily: 'system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <main style={{ maxWidth: '32rem', textAlign: 'center', display: 'grid', gap: '12px' }}>
          <h1 style={{ fontSize: '1.5rem', margin: 0 }}>حدث خطأ غير متوقع</h1>
          <p style={{ color: '#556061', margin: 0, lineHeight: 1.7 }}>
            تعذّر إكمال الطلب. تم تسجيل الخطأ وسنعمل على معالجته.
          </p>
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
        </main>
      </body>
    </html>
  );
}
