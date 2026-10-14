/**
 * Shared child-process runner for the synthetic certification drivers (fullSession.ts, restartBattery.ts, certificationBattery.ts).
 * PARENT-SAFE: imports no DB/EventBus/broker module at evaluation time (see fullSession.ts header). Each session runs in its own CHILD
 * process (fullSessionChild.ts) with the isolation env set AT SPAWN TIME.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';
import type { FullSessionSpec } from './fullSessionPlan';
import { assertDiskSpace, loadArtifactPolicy, retainSessionEvidence } from './artifactLifecycle';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildChildEnv(dbPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LIVE_ARM;
  env.SYNTHETIC_SIMULATION = 'true';
  env.PAPER_TRADING_ONLY = 'true';
  env.ARGUS_DB_PATH = dbPath;
  env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
  env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true';
  env.OPENALICE_ENABLED = 'false';
  env.ARGUS_OPPORTUNITY_LOOP_ENABLED = 'false';
  env.ARGUS_BROAD_UNIVERSE_ENABLED = 'false';
  env.ARGUS_MARKET_MOVERS_ENABLED = 'false';
  env.ARGUS_ACTIVE_BROKER = 'internal_paper';
  env.ARGUS_NEWS_ENGINE_ENABLED = 'false';
  env.ARGUS_POST_MARKET_ANALYSIS_ENABLED = 'false';
  // Isolated synthetic session: no real broker/AI keys are ever stored in its DB. When the
  // operator's environment provides no ENCRYPTION_SECRET, use a synthetic-only value (same
  // pattern as vitest.setup.ts) so EncryptionService's fail-closed check passes without
  // touching any real secret. Never logged, never persisted outside the isolated session.
  if (!env.ENCRYPTION_SECRET) {
    env.ENCRYPTION_SECRET = 'SYNTHETIC_SESSION_ONLY_DO_NOT_USE_FOR_REAL_KEYS_2026_10_11';
  }
  return env;
}

export interface ChildRunResult {
  ok: boolean;
  outputPath: string;
  data: any | null;
  error?: string;
}

export async function runSpecInChild(spec: FullSessionSpec): Promise<ChildRunResult> {
  // Any driver (fullSession, soak, restartBattery) can run under a calibration profile via ARGUS_SYNTH_CALIBRATION_PROFILE without a code change.
  const envProfile = process.env.ARGUS_SYNTH_CALIBRATION_PROFILE;
  if (spec.calibrationProfile === undefined && envProfile) {
    if (envProfile !== 'PRODUCTION_OCT14' && envProfile !== 'POSITIVE_CAPABILITY') throw new Error(`ARGUS_SYNTH_CALIBRATION_PROFILE must be PRODUCTION_OCT14 or POSITIVE_CAPABILITY (got ${envProfile})`);
    spec = { ...spec, calibrationProfile: envProfile };
  }
  const { dbPath } = computeSyntheticSimulationPaths(spec.simulationId);
  const policy = loadArtifactPolicy();
  // Disk preflight (2026-10-14): never start a session the drive cannot hold (the system drive had 4.3 GB free during the Oct 14 incident).
  assertDiskSpace(path.dirname(dbPath), policy.minFreeDiskGb);
  const env = buildChildEnv(dbPath);
  // Operator-gated cold-start bootstrap: environment control only (the flag is a documented
  // operator gate; ideas still face the full consensus/Risk/OMS path). Set per-spec so the
  // trade-lifecycle run is explicit and auditable.
  if (spec.coldStartBootstrap === true) env.QUANT_COLD_START_BOOTSTRAP_ENABLED = 'true';
  const childScriptPath = path.join(__dirname, 'fullSessionChild.ts');
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const specArg = `--spec=${encodeURIComponent(JSON.stringify(spec))}`;
  console.log(`\n>>> launching: ${spec.label} [db=${dbPath}]`);
  const started = Date.now();
  const code: number = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--use-system-ca', tsxCliPath, childScriptPath, specArg], {
      env, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (c) => resolve(c ?? 1));
  });
  console.log(`<<< finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ${spec.label} (exit=${code})`);
  if (code !== 0) return { ok: false, outputPath: spec.outputPath, data: null, error: `child exit ${code}` };
  try {
    const data = JSON.parse(fs.readFileSync(spec.outputPath, 'utf8'));
    // Evidence follows the verdict: keep the session database beside the result so the independent oracles can be re-run later.
    const retention = retainSessionEvidence(data?.dbPath ?? dbPath, spec.outputPath, policy);
    data.evidenceRetention = retention;
    try { fs.writeFileSync(spec.outputPath, JSON.stringify(data, null, 2)); } catch { /* best effort */ }
    return { ok: true, outputPath: spec.outputPath, data };
  } catch (e: any) {
    return { ok: false, outputPath: spec.outputPath, data: null, error: `result read failed: ${e?.message}` };
  }
}

export function summarizeResult(data: any): any {
  const c = data.certification;
  return {
    label: data.label,
    certification: c?.certification ?? null,
    tradeObserved: c?.tradeObserved ?? null,
    stages: c?.stages ?? null,
    firstBlockingStage: c?.firstBlockingStage ?? null,
    reason: c?.reason ?? null,
    zeroTradeReason: c?.zeroTradeReason ?? null,
    realizedPnl: data.brokerSummary?.realizedPnl ?? null,
    orders: data.brokerSummary?.orderCount ?? null,
    fills: c?.counts?.fills ?? null,
    invariantViolations: (c?.invariantViolations ?? []).map((v: any) => v.code),
    faultOutcomes: (data.faultOutcomes ?? []).map((f: any) => ({
      kind: f.kind, phase: f.phase, atBar: f.atBar, verdict: f.verdict, detail: f.detail,
    })),
    wallClockS: +(data.wallClockDurationMs / 1000).toFixed(1),
    eventLoopP95: data.eventLoop?.p95 ?? null,
    rssPeakMb: data.memory?.rssPeakMb ?? null,
  };
}

