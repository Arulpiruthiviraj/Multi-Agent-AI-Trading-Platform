/**
 * Headless / API-only startup — canonical engine daemon (no Vite/SPA).
 * Preserved npm script; delegates to scripts/argus-engine.ts.
 */
await import('./argus-engine.ts');
