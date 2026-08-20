#!/usr/bin/env node
/**
 * ARGUS ENGINE DAEMON entrypoint.
 *
 * Boots the existing Argus Core (ArgusCoreBoot → TradingEngine → RiskEngine → OMS)
 * with HTTP/WebSocket adapters. Does not require React/Vite.
 *
 * This is NOT a second trading brain. Same singletons as browser mode.
 */
process.env.ARGUS_HEADLESS = 'true';
process.env.ARGUS_ENGINE = 'true';
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const { claimEnginePid } = await import('../src/server/app/enginePid');
try {
  claimEnginePid(process.pid);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

console.log('[Argus Engine] starting dedicated daemon (same Argus Core as browser mode).');
await import('../server.ts');
