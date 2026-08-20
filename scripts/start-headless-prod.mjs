/**
 * Production headless entry — run after `npm run build`.
 * Sets ARGUS_HEADLESS and loads dist/server.cjs.
 */
process.env.ARGUS_HEADLESS = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
await import('../dist/server.cjs');
