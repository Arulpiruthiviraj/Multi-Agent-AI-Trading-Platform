/**
 * Production Argus Engine daemon — run after `npm run build`.
 */
process.env.ARGUS_HEADLESS = 'true';
process.env.ARGUS_ENGINE = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
await import('../dist/server.cjs');
