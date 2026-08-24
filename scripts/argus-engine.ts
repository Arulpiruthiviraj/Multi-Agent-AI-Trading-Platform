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

// Real bug found and fixed: server.ts (imported at the bottom of this file) is what actually
// calls dotenv.config() - too late for the QUANT_JAVA_CORE_ENABLED check below, which ran before
// .env was ever loaded into process.env and so always evaluated false regardless of the real
// .env value. dotenv.config() is safe to call again here (and again inside server.ts) - it never
// overwrites a key already present in process.env, same pattern EncryptionService.ts's own
// independent dotenv.config() call already relies on elsewhere in this codebase.
const dotenv = (await import('dotenv')).default;
dotenv.config();

const { claimEnginePid } = await import('../src/server/app/enginePid');
try {
  claimEnginePid(process.pid);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

console.log('[Argus Engine] starting dedicated daemon (same Argus Core as browser mode).');

// Optional companion, mirrors devWithOpenAlice.ts's own opt-in Java Quant Core start (same
// QUANT_JAVA_CORE_ENABLED flag, same advisory-only/no-broker-access contract) - previously only
// the full `npm run dev` ecosystem launcher brought this up, so `./argus start`'s leaner engine
// daemon never did. Fire-and-forget: never awaited, never allowed to delay or block engine boot -
// startJavaQuantCoreAndWait() itself never throws, matching the existing companion-launch pattern.
if (String(process.env.QUANT_JAVA_CORE_ENABLED || '').toLowerCase() === 'true') {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { startJavaQuantCoreAndWait } = await import('./lib/javaQuantCoreLauncher.ts');
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  void startJavaQuantCoreAndWait(path.resolve(scriptDir, '..'));
}

await import('../server.ts');
