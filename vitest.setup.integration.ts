/**
 * Loads .env.local for local runs. In CI the variables are provided by the
 * workflow environment, so a missing file is not an error.
 */
try {
  process.loadEnvFile('.env.local');
} catch {
  // CI path: environment already populated.
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Integration tests need DATABASE_URL. Start the database and copy .env.example to .env.local.',
  );
}
