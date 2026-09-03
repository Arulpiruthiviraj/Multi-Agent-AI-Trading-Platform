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

const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// Optional companion, mirrors devWithOpenAlice.ts's own opt-in Java Quant Core start (same
// QUANT_JAVA_CORE_ENABLED flag, same advisory-only/no-broker-access contract) - previously only
// the full `npm run dev` ecosystem launcher brought this up, so `./argus start`'s leaner engine
// daemon never did. Fire-and-forget: never awaited, never allowed to delay or block engine boot -
// startJavaQuantCoreAndWait() itself never throws, matching the existing companion-launch pattern.
if (String(process.env.QUANT_JAVA_CORE_ENABLED || '').toLowerCase() === 'true') {
  const { startJavaQuantCoreAndWait } = await import('./lib/javaQuantCoreLauncher.ts');
  void startJavaQuantCoreAndWait(repoRoot);
}

// Chronos/Kronos companion - on by default (opposite polarity from Java Quant Core above: Chronos
// is a normal, expected companion, same ARGUS_SKIP_CHRONOS convention devWithOpenAlice.ts already
// uses for `npm run dev`, not an opt-in experimental one). Mirrors devWithOpenAlice.ts's own
// startChronosAndWait() so `./argus start`/`argus-cli start`'s leaner engine daemon does not leave
// Kronos KRONOS_UNAVAILABLE just because nobody ran `npm run ai:serve` in another terminal.
// Fire-and-forget, same contract as the Java block above - ensureChronosRunning() never throws.
if (String(process.env.ARGUS_SKIP_CHRONOS || '').toLowerCase() !== 'true') {
  const { ensureChronosRunning } = await import('./lib/chronosLauncher.ts');
  void ensureChronosRunning(repoRoot);
}

// LangGraph research companion (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md) - opt-in, same
// off-by-default polarity as the Java Quant Core block above, not Chronos's on-by-default one:
// this is a new, unvalidated, shadow-only advisory capability, not yet a normal expected
// companion. Isolated Python process, loopback HTTP only, no broker credentials, no SQLite
// access, never on the live trading path - see LangGraphResearchService.ts's own header for the
// enforced boundary. Fire-and-forget, same contract as the other two companions above.
if (String(process.env.LANGGRAPH_RESEARCH_ENABLED || '').toLowerCase() === 'true') {
  const { ensureLangGraphResearchRunning } = await import('./lib/langGraphLauncher.ts');
  const { langGraphResearch } = await import('../src/server/config/langGraphResearch.ts');
  void ensureLangGraphResearchRunning(repoRoot, langGraphResearch.port);
}

await import('../server.ts');
