/**
 * Pause-only disk-floor safety guard (owner instruction 2026-10-15, hardened after the 15:31 ET incident).
 *
 * Incident: free space fell 17.95 GB -> 10.44 GB in ~10 s. The guard DETECTED the breach but its response never ran: the
 * pause reason ("...below_<15GB") was interpolated into a `cmd /c` string and `<` was parsed as shell redirection, so the CLI
 * was never invoked and nothing paused. A guard that detects but cannot act is worse than no guard because it looks healthy.
 *
 * Contract of this module:
 *  - The response is invoked WITHOUT a shell (execFile, argv array). Dynamic data is never interpolated into a command line.
 *  - The reason string is additionally restricted to [A-Za-z0-9_.-].
 *  - Success is VERIFIED from the engine's own pause response (tradingState === TRADING_PAUSED), not from an exit code alone.
 *  - A failed or unverified pause is logged as a distinct FAILED event and retried on the next sample (never silently dropped).
 *  - Idempotent: an already-paused engine is not re-paused every sample.
 *  - It only pauses. It never resumes, deletes, or touches the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface PauseCommand { file: string; args: string[]; cwd: string }
export interface PauseOutcome { ok: boolean; verified: boolean; detail: string }

export interface GuardDeps {
  /** Free GB on the volume that holds the database / temp files. */
  readFreeGb(): number;
  runPause(reason: string): Promise<PauseOutcome>;
  log(line: string): void;
  now(): number;
}

export interface GuardState { paused: boolean; consecutivePauseFailures: number }

/** Only characters that are inert in every shell and in the CLI's own `--reason=` parsing. */
export function safeReason(freeGb: number, floorGb: number): string {
  const raw = `AUTO_disk_floor_${freeGb.toFixed(1)}GB_below_${floorGb}GB`;
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Exact production invocation of the CLI: node + tsx loader + argv array. No shell, no `npm run` wrapper. */
export function buildPauseCommand(repoRoot: string, reason: string, nodeExecPath = process.execPath): PauseCommand {
  return {
    file: nodeExecPath,
    args: ['--env-file-if-exists=.env', '--use-system-ca', '--import', 'tsx', path.join('scripts', 'argus-cli.ts'), 'pause', `--reason=${reason}`],
    cwd: repoRoot,
  };
}

/** The CLI prints JSON containing `tradingState`; a pause only counts when the engine itself reports TRADING_PAUSED. */
export function parsePauseVerification(stdout: string): { verified: boolean; detail: string } {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return { verified: false, detail: 'no JSON in CLI output' };
  try {
    const j = JSON.parse(stdout.slice(start, end + 1)) as { tradingState?: string; status?: string; pauseKind?: string };
    const verified = j.tradingState === 'TRADING_PAUSED';
    return { verified, detail: `tradingState=${j.tradingState ?? '?'} pauseKind=${j.pauseKind ?? '?'} status=${j.status ?? '?'}` };
  } catch { return { verified: false, detail: 'unparseable CLI JSON' }; }
}

export function runPauseCommand(cmd: PauseCommand, timeoutMs = 120_000): Promise<PauseOutcome> {
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { cwd: cmd.cwd, timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, verified: false, detail: `exit/err: ${(err as Error).message.slice(0, 300)} ${String(stderr).slice(0, 200)}` }); return; }
      const v = parsePauseVerification(String(stdout));
      resolve({ ok: true, verified: v.verified, detail: v.detail });
    });
  });
}

/** One guard sample. Pure orchestration over injected deps so every branch is testable without a disk, a CLI, or an engine. */
export async function guardTick(state: GuardState, floorGb: number, deps: GuardDeps): Promise<GuardState> {
  let freeGb: number;
  try { freeGb = deps.readFreeGb(); } catch (e) { deps.log(`${new Date(deps.now()).toISOString()} SAMPLE_ERROR ${(e as Error).message}`); return state; }
  const below = freeGb < floorGb;
  deps.log(`${new Date(deps.now()).toISOString()} freeGB=${freeGb.toFixed(2)}${below ? ' BELOW_FLOOR' : ''}`);
  if (!below) return { paused: false, consecutivePauseFailures: 0 }; // recovered: re-arm so a later breach pauses again
  if (state.paused) return state; // idempotent: already paused for this breach
  deps.log(`${new Date(deps.now()).toISOString()} PAUSING automated entries: free disk ${freeGb.toFixed(2)} GB < ${floorGb} GB floor`);
  let outcome: PauseOutcome;
  try { outcome = await deps.runPause(safeReason(freeGb, floorGb)); } catch (e) { outcome = { ok: false, verified: false, detail: (e as Error).message }; }
  if (outcome.ok && outcome.verified) {
    deps.log(`${new Date(deps.now()).toISOString()} PAUSE_VERIFIED ${outcome.detail}`);
    return { paused: true, consecutivePauseFailures: 0 };
  }
  const failures = state.consecutivePauseFailures + 1;
  deps.log(`${new Date(deps.now()).toISOString()} PAUSE_FAILED (attempt ${failures}; will retry next sample) ${outcome.ok ? 'UNVERIFIED' : 'ERROR'}: ${outcome.detail}`);
  return { paused: false, consecutivePauseFailures: failures };
}

function main(): void {
  const repoRoot = path.resolve(process.env.ARGUS_REPO_ROOT || process.cwd());
  const logPath = process.env.ARGUS_DISK_GUARD_LOG || path.join(repoRoot, 'data', 'logs', 'disk_floor_guard.log');
  const floorGb = Number(process.env.GUARD_FLOOR_GB || 15);
  const probeDir = process.env.ARGUS_DISK_GUARD_PROBE_DIR || path.join(repoRoot, 'data');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const deps: GuardDeps = {
    readFreeGb: () => { const s = fs.statfsSync(probeDir); return Number(s.bavail) * Number(s.bsize) / 1024 ** 3; },
    runPause: (reason) => runPauseCommand(buildPauseCommand(repoRoot, reason)),
    log: (line) => { try { fs.appendFileSync(logPath, line + '\n'); } catch { /* the guard must keep sampling */ } },
    now: () => Date.now(),
  };
  let state: GuardState = { paused: false, consecutivePauseFailures: 0 };
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { state = await guardTick(state, floorGb, deps); } finally { busy = false; } };
  void tick();
  setInterval(() => { void tick(); }, Number(process.env.ARGUS_DISK_GUARD_INTERVAL_MS || 10_000));
}

if (process.argv[1] && /diskFloorGuard\.[cm]?[jt]s$/.test(process.argv[1])) main();
