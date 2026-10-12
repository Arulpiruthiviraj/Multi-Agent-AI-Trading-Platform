/**
 * Pure, testable pieces of the one-command engine lifecycle (start / restart / resume), added 2026-10-12 after
 * a day of manual workarounds. Nothing here talks to the network or the process table directly: callers inject
 * fetch/sleep/clock, so the decisions that matter (is it safe to resume, did we wait long enough) are unit tested.
 *
 * Safety contract (unchanged): resuming trading is always an explicit operator request (`--enable-trading`, or
 * `--resume` on restart, which only restores a state that was already TRADING_ENABLED). The server-side resume
 * route still applies every safety check. This module only decides WHEN to ask, never bypasses a refusal.
 */

/** Real boot on this host takes 155-170 s (migrations + model probes + broker sync); 150 s used to report a false failure. */
export const DEFAULT_START_TIMEOUT_MS = 360_000;
/** The reconciliation cycle runs about every 5 min and a fresh process can report ACCOUNT_VALUATION_UNAVAILABLE once. */
export const DEFAULT_RECONCILIATION_WAIT_MS = 12 * 60_000;
export const RECONCILIATION_POLL_MS = 15_000;

export interface StartEnvOptions {
  withOllama: boolean;
}

/**
 * Optional local inference (Ollama) is OFF by default for engine starts: on 2026-10-12 a relaunched Ollama on a
 * 16 GB host thrashed memory (942/1000 requests HTTP 500). An explicit ARGUS_SKIP_OLLAMA in the caller's
 * environment always wins; `--with-ollama` opts back in.
 */
export function buildEngineEnv(base: NodeJS.ProcessEnv, opts: StartEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ARGUS_HEADLESS: 'true', ARGUS_ENGINE: 'true' };
  if (opts.withOllama) {
    if (env.ARGUS_SKIP_OLLAMA === undefined) env.ARGUS_SKIP_OLLAMA = 'false';
  } else if (env.ARGUS_SKIP_OLLAMA === undefined) {
    env.ARGUS_SKIP_OLLAMA = 'true';
  }
  return env;
}

export interface ReconciliationSnapshot {
  tradingState?: string;
  broker?: { syncState?: string } | null;
  latest?: { mismatches?: unknown[] | null; matches?: number } | null;
  error?: string;
}

/** Clean = broker synchronised AND a latest cycle exists with no mismatches. Missing data is never "clean". */
export function reconciliationIsClean(data: ReconciliationSnapshot | null | undefined): boolean {
  if (!data || data.error) return false;
  if (data.broker?.syncState !== 'READY') return false;
  const latest = data.latest;
  if (!latest) return false;
  const mismatches = latest.mismatches;
  return Array.isArray(mismatches) ? mismatches.length === 0 : mismatches == null;
}

export interface WaitDeps {
  fetchStatus: () => Promise<ReconciliationSnapshot>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type ReconciliationWaitResult =
  | { clean: true; waitedMs: number }
  | { clean: false; waitedMs: number; lastSeen: 'MISMATCH' | 'UNAVAILABLE' };

/** Polls until reconciliation is clean or the deadline passes. A fetch error counts as UNAVAILABLE, never as clean. */
export async function waitForCleanReconciliation(
  deps: WaitDeps,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ReconciliationWaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RECONCILIATION_WAIT_MS;
  const pollMs = opts.pollMs ?? RECONCILIATION_POLL_MS;
  const started = deps.now();
  let lastSeen: 'MISMATCH' | 'UNAVAILABLE' = 'UNAVAILABLE';
  for (;;) {
    try {
      const data = await deps.fetchStatus();
      if (reconciliationIsClean(data)) return { clean: true, waitedMs: deps.now() - started };
      lastSeen = data?.latest && Array.isArray(data.latest.mismatches) && data.latest.mismatches.length > 0 ? 'MISMATCH' : 'UNAVAILABLE';
    } catch {
      lastSeen = 'UNAVAILABLE';
    }
    if (deps.now() - started >= timeoutMs) return { clean: false, waitedMs: deps.now() - started, lastSeen };
    await deps.sleep(pollMs);
  }
}

export interface PreRestartState {
  tradingState?: string;
  emergencyStopActive?: boolean;
}

/**
 * `restart --resume` restores trading ONLY if it was genuinely running before: TRADING_ENABLED and no emergency
 * stop. A paused or emergency-stopped engine stays that way after a restart (a pause may be a deliberate safety
 * action and must never be undone by a restart).
 */
export function shouldRestoreTrading(pre: PreRestartState): boolean {
  return pre.tradingState === 'TRADING_ENABLED' && pre.emergencyStopActive !== true;
}
