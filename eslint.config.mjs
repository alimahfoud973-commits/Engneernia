import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Flat config. eslint-config-next v16 ships native flat configs, so no
 * compatibility shim is needed.
 *
 * The custom rules below are guard rails for the two things this codebase
 * must never get wrong: floating-point money, and untyped escapes in
 * authorization or financial code.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'src/db/migrations/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Monetary values are integer minor units (bigint). See src/lib/money.',
        },
        {
          name: 'parseInt',
          message: 'Use Number.parseInt explicitly, or BigInt for monetary values.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'round',
          message:
            'Do not round money with Math.round. Use divRoundHalfAwayFromZero in src/lib/money.',
        },
      ],
    },
  },
];

export default config;
