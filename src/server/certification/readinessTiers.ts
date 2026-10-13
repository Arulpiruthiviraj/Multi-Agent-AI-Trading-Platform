/**
 * readinessTiers.ts - separates "what must be proven before WHICH kind of PAPER run" from one global NO-GO.
 *
 * Why (2026-10-13): the release driver reported a single NO_GO whose blockers mixed four different questions - a missing
 * Quant lifecycle authorization (a QUANT_FIRST question: unauthorized Quant ideas already fall back to consensus, they are
 * not silently executed), an unfinished multi-hour soak (an UNATTENDED question), advisory-AI wiring, and genuine
 * attended-PAPER safety. Reading them as one verdict forced either an override or a fraudulent authorization. Each check now
 * declares which tiers it gates; a tier is READY only when every check that gates it is PASS. Nothing here turns a failing
 * check green: a check that is not PASS still blocks every tier it gates, and LIVE is always NO_GO.
 */
import type { ReleaseCheck } from './releaseCertificationDriver';

export type ReadinessTier = 'CONTROLLED_PAPER' | 'UNATTENDED_PAPER' | 'QUANT_FIRST' | 'LIVE';
export const ALL_TIERS: ReadinessTier[] = ['CONTROLLED_PAPER', 'UNATTENDED_PAPER', 'QUANT_FIRST', 'LIVE'];

const UNATTENDED_AND_UP: ReadinessTier[] = ['UNATTENDED_PAPER', 'QUANT_FIRST', 'LIVE'];

/** Checks that gate FEWER than all four tiers. Any check not listed gates every tier (conservative default). */
export const CHECK_GATES: Record<string, ReadinessTier[]> = {
  // Quant-first authority: a different question from "is it safe to run attended PAPER".
  AUTHORIZED_PAPER_QUANT_STRATEGIES: ['QUANT_FIRST', 'LIVE'],
  QUANT_POLICY_REACHABILITY: ['QUANT_FIRST', 'LIVE'],
  // Unattended operation: soak, watchdog, resource census, runtime latency distribution, the Java artifact the advisory core runs from.
  FULL_SESSION: UNATTENDED_AND_UP,
  WALL_CLOCK_SOAK: UNATTENDED_AND_UP,
  WATCHDOG: UNATTENDED_AND_UP,
  MEMORY: UNATTENDED_AND_UP,
  QUEUES: UNATTENDED_AND_UP,
  LISTENERS: UNATTENDED_AND_UP,
  TIMERS: UNATTENDED_AND_UP,
  WORKERS: UNATTENDED_AND_UP,
  SCHEDULER_P50: UNATTENDED_AND_UP,
  SCHEDULER_P95: UNATTENDED_AND_UP,
  SCHEDULER_P99: UNATTENDED_AND_UP,
  SCHEDULER_MAX: UNATTENDED_AND_UP,
  JAVA_ARTIFACT_HASH: UNATTENDED_AND_UP,
  // Advisory AI (Jev): never execution-critical, so never a PAPER gate; it must be certified before LIVE.
  JEV_CONFIGURED: ['LIVE'],
  JEV_WIRING: ['LIVE'],
  JEV_GOVERNOR: ['LIVE'],
  JEV_SCHEMA: ['LIVE'],
  JEV_FAILURE_MODE: ['LIVE'],
};

export function gatesFor(field: string): ReadinessTier[] {
  return CHECK_GATES[field] ?? ALL_TIERS;
}

export interface TierVerdict {
  tier: ReadinessTier;
  /** READY: every check gating this tier is PASS. NOT_READY: otherwise. NO_GO: LIVE, always (LIVE_NO_GO policy). */
  status: 'READY' | 'NOT_READY' | 'NO_GO';
  blockingChecks: string[];
  failedChecks: string[];
}

export function computeTierVerdicts(checks: ReleaseCheck[]): TierVerdict[] {
  return ALL_TIERS.map((tier) => {
    const gating = checks.filter((c) => gatesFor(c.field).includes(tier));
    const blocking = gating.filter((c) => c.state !== 'PASS');
    return {
      tier,
      status: tier === 'LIVE' ? 'NO_GO' : blocking.length === 0 ? 'READY' : 'NOT_READY',
      blockingChecks: blocking.map((c) => c.field),
      failedChecks: blocking.filter((c) => c.state === 'FAIL').map((c) => c.field),
    };
  });
}
