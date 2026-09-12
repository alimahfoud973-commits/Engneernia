/**
 * The single schema entry point Drizzle Kit reads for migrations.
 * Later phases append their tables here; nothing else imports the files
 * directly, so the migration surface stays explicit.
 */
export * from './enums';
export * from './columns';
export * from './identity';
export * from './audit';
