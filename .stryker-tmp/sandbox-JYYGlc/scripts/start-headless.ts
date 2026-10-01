/**
 * Headless / API-only startup — canonical engine daemon (no Vite/SPA).
 * Preserved npm script; delegates to scripts/argus-engine.ts.
 */
// @ts-nocheck

await import('./argus-engine.ts');
