/**
 * Headless / API-only startup — sets ARGUS_HEADLESS before loading server.ts.
 * Trading core + REST API run; Vite and static SPA are skipped.
 */
process.env.ARGUS_HEADLESS = 'true';
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

await import('../server.ts');
