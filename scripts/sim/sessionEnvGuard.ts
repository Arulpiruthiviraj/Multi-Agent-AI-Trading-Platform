/**
 * Synthetic-session EFFECTIVE configuration guard + manifest (2026-10-14).
 *
 * Incident: candidate 5e36e191's seed-33 session ran in a worktree with no `.env`, so ARGUS_PORTFOLIO_INTEL_ENABLED was off, PortfolioMonitor
 * still ran but wrote zero decision telemetry, and the independent oracle reported an open position as "unprotected" (an environment difference,
 * not a protection defect). Requiring a `.env` FILE is not enough, and copying the production `.env` would import broker credentials into a
 * synthetic run. The guard therefore checks the RESOLVED effective configuration (wherever it came from) and refuses credentials:
 *   - required isolation: SYNTHETIC_SIMULATION=true, PAPER_TRADING_ONLY=true, no broker/data-provider credentials present;
 *   - required production-equivalent behavior flags (names from config/continuousIntelligence.json, never literals here);
 *   - a sanitized manifest (allowlisted non-secret flag values, credential PRESENCE as booleans only) saved with the artifacts.
 */
import fs from 'node:fs';
import path from 'node:path';

const CREDENTIAL_VARS = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_API_SECRET', 'IBKR_ACCOUNT_ID', 'IBKR_GATEWAY_URL', 'COINBASE_API_KEY', 'COINBASE_API_SECRET', 'QUESTRADE_REFRESH_TOKEN', 'ENCRYPTION_SECRET', 'AUTH_PASSWORD'] as const;
const FLAG_ALLOWLIST = /(_ENABLED$|^PAPER_TRADING_ONLY$|^SYNTHETIC_SIMULATION$|^NODE_ENV$|^QUANT_ENGINE_INTERVAL_MS$)/;

export interface SessionConfigManifest {
  generatedAt: string;
  flags: Record<string, string>;
  credentialsPresent: Record<string, boolean>;
  requiredFlags: Record<string, boolean>;
  problems: string[];
}

export function buildSessionConfigManifest(env: NodeJS.ProcessEnv, requiredEnabledFlagNames: string[], now: Date = new Date()): SessionConfigManifest {
  const flags: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (FLAG_ALLOWLIST.test(k) && v !== undefined) flags[k] = String(v);
  const credentialsPresent: Record<string, boolean> = {};
  for (const k of CREDENTIAL_VARS) credentialsPresent[k] = !!(env[k] && String(env[k]).trim());
  const requiredFlags: Record<string, boolean> = {};
  for (const k of requiredEnabledFlagNames) requiredFlags[k] = env[k] === 'true';
  const problems: string[] = [];
  if (env.SYNTHETIC_SIMULATION !== 'true') problems.push('SYNTHETIC_SIMULATION is not true');
  if (env.PAPER_TRADING_ONLY !== 'true') problems.push('PAPER_TRADING_ONLY is not true');
  for (const [k, present] of Object.entries(credentialsPresent)) if (present) problems.push(`credential variable ${k} is present in a synthetic session (isolation breach)`);
  for (const [k, ok] of Object.entries(requiredFlags)) if (!ok) problems.push(`required production-equivalent flag ${k} is not enabled`);
  return { generatedAt: now.toISOString(), flags, credentialsPresent, requiredFlags, problems };
}

export function assertSessionEffectiveConfiguration(env: NodeJS.ProcessEnv, requiredEnabledFlagNames: string[], outDir?: string): SessionConfigManifest {
  const manifest = buildSessionConfigManifest(env, requiredEnabledFlagNames);
  if (outDir) {
    try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'session-config-manifest.json'), JSON.stringify(manifest, null, 2)); } catch { /* best effort */ }
  }
  if (env.ARGUS_SYNTH_ALLOW_CONFIG_DEVIATION === '1') return manifest;
  if (manifest.problems.length) {
    throw new Error(`FATAL: synthetic session configuration is not certifiable: ${manifest.problems.join('; ')}. Set ARGUS_SYNTH_ALLOW_CONFIG_DEVIATION=1 only for a deliberate, labeled deviation run.`);
  }
  return manifest;
}

/** Names of behavior flags a like-for-like certification must have enabled, read from the reviewed config (no literals in code). */
export function requiredFlagNamesFromConfig(repoRoot: string): string[] {
  const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'continuousIntelligence.json'), 'utf8')) as Record<string, unknown>;
  return [cfg.portfolioIntelEnabledEnvVar].filter((x): x is string => typeof x === 'string' && x.length > 0);
}
