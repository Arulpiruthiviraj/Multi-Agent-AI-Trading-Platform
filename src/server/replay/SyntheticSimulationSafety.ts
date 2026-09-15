/**
 * ==========================================================
 * Module: SyntheticSimulationSafety
 *
 * Synthetic Market Session Simulator, Phase 1 (2026-09-14 mandate): "Build isolated simulation
 * boundary and safety assertions... If the simulator cannot prove isolation, it must refuse to
 * start." This module is that proof, not a convention - every check here either passes or the
 * caller throws before a synthetic session is ever installed.
 *
 * Two distinct checks, because "isolated" has two different failure modes:
 *   1. assertSyntheticSimulationIsolation() - PRE-FLIGHT. Checked before any session exists: env
 *      flags, and that the DB/session-marker paths the caller is about to use are not the real
 *      production files. Reuses resolveDbDir()/sessionRecovery.ts's own DEFAULT_PATH constant
 *      rather than re-deriving "what is the production path" independently, so this can never
 *      silently drift out of sync with what db/index.ts or sessionRecovery.ts actually resolve to.
 *   2. assertActiveSessionIsSynthetic() - POST-INSTALL. Checked once a session (broker + clock)
 *      exists, proving the installed broker is structurally incapable of live order submission -
 *      not merely configured for paper mode, but a broker whose own liveTrading() throws and whose
 *      own getCapabilities().liveTrading is false. This is what makes
 *      "REAL_BROKER_ORDER_SUBMISSION = IMPOSSIBLE" a checkable fact rather than an assertion in a
 *      comment.
 *
 * Deliberately does NOT modify any production config, threshold, or gate - purely refuse-to-start
 * checks, per the mandate's own "do not weaken RiskEngine... do not modify production
 * configuration merely to produce a trade."
 * ==========================================================
 */
import path from 'node:path';
import fs from 'node:fs';
import { resolveDbDir } from '../db/resolveDbDir';
import type { BrokerPlugin } from '../../brokers/BrokerAdapter';

export class SyntheticSimulationIsolationError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`SYNTHETIC_SIMULATION_ISOLATION_FAILED - refusing to start:\n${reasons.map((r) => `  - ${r}`).join('\n')}`);
    this.name = 'SyntheticSimulationIsolationError';
  }
}

/** The real production DB path, computed the exact same way db/index.ts computes it (reused, not
 *  re-derived) - so this check can never fall out of sync with what "the production DB" actually
 *  means in this codebase. */
export function productionDbPath(): string {
  const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
  return path.join(dbDir, 'argus.db');
}

/** The real production session-recovery marker path - mirrors sessionRecovery.ts's own
 *  DEFAULT_PATH (data/.argus_runtime_session.json), which that module does not export, so this is
 *  reconstructed from the same cwd-relative convention rather than importing a private constant. */
export function productionSessionMarkerPath(): string {
  return path.join(process.cwd(), 'data', '.argus_runtime_session.json');
}

export interface SyntheticSimulationPreflightOptions {
  /** The ARGUS_DB_PATH this simulation session intends to use (or will set). */
  dbPath: string;
  /** The session-recovery marker path this session intends to use, if it touches that subsystem
   *  at all. Omit if the simulation never boots ArgusCoreBoot/sessionRecovery. */
  sessionMarkerPath?: string;
}

/**
 * Pre-flight isolation proof - call BEFORE constructing/installing a synthetic session. Throws
 * SyntheticSimulationIsolationError (never returns a boolean to silently ignore) if isolation
 * cannot be proven.
 */
export function assertSyntheticSimulationIsolation(options: SyntheticSimulationPreflightOptions): void {
  const reasons: string[] = [];

  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    reasons.push('process.env.SYNTHETIC_SIMULATION must be "true" - a synthetic session must declare itself as such');
  }
  if (process.env.PAPER_TRADING_ONLY !== 'true') {
    reasons.push('process.env.PAPER_TRADING_ONLY must be "true" - LIVE must be structurally impossible for the whole process, not just this session (liveOrderAuthorization.ts\'s own P0.1 gate reads this same env var)');
  }
  if (process.env.LIVE_ARM === 'true') {
    reasons.push('process.env.LIVE_ARM must not be "true" - the per-process LIVE arm (5-layer live arming, layer 5) must be cold for a synthetic session');
  }

  const resolvedRequestedDbPath = path.resolve(options.dbPath);
  const resolvedProdDbPath = path.resolve(productionDbPath());
  if (resolvedRequestedDbPath === resolvedProdDbPath) {
    reasons.push(`dbPath (${resolvedRequestedDbPath}) resolves to the production database - a synthetic session must use an isolated tmp/scratch DB, never data/argus.db`);
  }

  if (options.sessionMarkerPath) {
    const resolvedRequestedMarkerPath = path.resolve(options.sessionMarkerPath);
    const resolvedProdMarkerPath = path.resolve(productionSessionMarkerPath());
    if (resolvedRequestedMarkerPath === resolvedProdMarkerPath) {
      reasons.push(`sessionMarkerPath (${resolvedRequestedMarkerPath}) resolves to the production restart-safety marker - must be isolated (see ArgusCoreBoot.restartSafety.test.ts's setSessionRecoveryPathForTests() pattern)`);
    }
  }

  if (reasons.length > 0) {
    throw new SyntheticSimulationIsolationError(reasons);
  }
}

/**
 * Post-install isolation proof - call AFTER a synthetic session's broker has been constructed,
 * before the session is wired into BrokerManager.getActiveBroker()'s replay-session lookup
 * (ReplayContext.ts's setActiveReplaySession()). Proves the installed broker is structurally
 * incapable of a real order, not merely that it is currently configured for paper mode (a config
 * value can be wrong; a broker whose liveTrading() unconditionally throws cannot be talked into
 * live trading by any config error).
 */
export function assertActiveSessionIsSynthetic(broker: BrokerPlugin): void {
  const reasons: string[] = [];

  const capabilities = broker.getCapabilities();
  if (capabilities.liveTrading) {
    reasons.push(`broker "${broker.id}" declares getCapabilities().liveTrading === true - a synthetic session's broker must declare liveTrading: false`);
  }

  let liveTradingThrows = false;
  try {
    broker.liveTrading();
  } catch {
    liveTradingThrows = true;
  }
  if (!liveTradingThrows) {
    reasons.push(`broker "${broker.id}".liveTrading() did not throw - a synthetic session's broker must hard-refuse a live-mode switch (see HistoricalReplayBroker.liveTrading() for the pattern), not merely default to paper`);
  }

  if (reasons.length > 0) {
    throw new SyntheticSimulationIsolationError(reasons);
  }
}
