// LABEL: UNIT - lifecycle certification bridge workflow against a temp DB.
// Proves the designed promotion route: synthetic RESEARCH EVIDENCE (SYNTHETIC_SEEDED /
// CERTIFICATION_FIXTURE_ONLY / NON_ORGANIC) -> evidence sufficiency gates -> unskippable
// operator review -> the EXISTING recordStrategyLifecycleTransition into an ISOLATED temp
// DB. Never touches the production DB; never seeds VALIDATED as a shortcut — the only
// VALIDATED row in this file is recorded BY THE BRIDGE WORKFLOW UNDER TEST, and the
// fixtures below are the environment, not organic evidence.
//

// LABEL: UNIT - lifecycle certification bridge (see header above for the full contract).
/**
 * Lifecycle Certification Bridge tests (2026-10-09, Priority 3).
 *
 * The Oct-9 forensic found 755 NO_LIFECYCLE_RECORD events and 0 privileged PAPER Quant
 * strategies; the Layer-3 probe confirmed LIFECYCLE_PROMOTION_ROUTE=ABSENT. This file
 * proves the designed bridge fills that missing link WITHOUT weakening anything:
 *
 *  1. insufficient evidence        -> no authority (only an UNTESTED baseline is recordable)
 *  2. bad OOS                      -> no authority (SHADOW at most)
 *  3. good backtest + poor walk-forward -> no authority (CANDIDATE at most)
 *  4. RETIRED strategy             -> no authority; PULLBACK_CONTINUATION stays retired
 *  5. legitimate reviewed qualification -> VALIDATED recorded by the workflow itself
 *     (isolated DB only) -> AUTHORIZED_QUANT_POLICY via the REAL resolver
 *  6. ACTIVE_EXPLORATION           -> REQUIRES_CONSENSUS (emission eligibility != authority)
 *  7. missing operator review      -> no transition, no authority (type + runtime gate)
 *  8. LIVE authority               -> impossible: inexpressible in the bridge vocabulary,
 *     and the paper-only env lock denies even a recorded VALIDATED row
 *
 * Strategy ids come from the canonical registry/config (never literals, except the
 * task-named PULLBACK_CONTINUATION which is derived from config/researchSafety.json).
 * Thresholds come from config/researchSafety.json via the bridge (never hardcoded here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { researchSafety } from '../config/researchSafety';
import { CORE_STRATEGIES, EXPERIMENTAL_STRATEGIES } from '../quant/strategies/StrategyEngine';
import { emptyEvidence, type StrategyEvidence } from '../research/promotionEngine';
// Type-only imports: erased at runtime, so they never trigger the db/strategy module
// imports (those load dynamically in beforeAll, after ARGUS_DB_PATH is set).
import type {
  BridgeTargetStatus,
  CertificationAssessment,
  CertificationProvenance,
  CertificationSamples,
  OperatorReview,
} from './certificationBridge';

describe('lifecycle certification bridge', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let bridge: typeof import('./certificationBridge');
  let eligibility: typeof import('../quant/strategies/StrategyEmissionEligibility');
  let authz: typeof import('../quant/QuantStrategyAuthorization');
  const savedEnv: Record<string, string | undefined> = {};

  // Distinct registry strategies per scenario so rows never collide across tests.
  // (BAD_OOS_ID uses an experimental-registry strategy because CORE_STRATEGIES[1] is
  // PULLBACK_CONTINUATION, which the retired scenario needs untouched until its own test.)
  const INSUFFICIENT_ID = CORE_STRATEGIES[0].id;
  const BAD_OOS_ID = EXPERIMENTAL_STRATEGIES[1].id;
  const POOR_WF_ID = CORE_STRATEGIES[2].id;
  const RETIRED_ID = CORE_STRATEGIES.find((s) => s.id === researchSafety.coreStrategyIds[1])!.id; // PULLBACK_CONTINUATION
  const QUALIFIED_ID = CORE_STRATEGIES[3].id;
  const EXPLORATION_ID = CORE_STRATEGIES[4].id;

  beforeAll(async () => {
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY']) savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_cert_bridge_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    // Dynamic imports AFTER ARGUS_DB_PATH is set: the db module migrates the isolated
    // temp DB on first import. Nothing here touches the production database.
    ({ sqliteDb } = await import('../db'));
    bridge = await import('./certificationBridge');
    eligibility = await import('../quant/strategies/StrategyEmissionEligibility');
    authz = await import('../quant/QuantStrategyAuthorization');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -- Synthetic research evidence fixtures (CERTIFICATION_FIXTURE_ONLY) ----------------
  // Built from promotionEngine.emptyEvidence() with the booleans under test flipped.
  // These are the ENVIRONMENT the bridge evaluates; every decision is the bridge's.

  const provenance = (tag: string): CertificationProvenance => ({
    evidenceIds: [`SYNTHETIC_SEEDED-backtest-${tag}`, `SYNTHETIC_SEEDED-oos-${tag}`],
    evidenceScope: 'CERTIFICATION_FIXTURE_ONLY synthetic research evidence — NON_ORGANIC, never production evidence',
    buildVersion: 'test-fixture-0.0.0',
  });

  /** Fully qualifying evidence: quarantine-clean, sufficient samples, all gates green. */
  function qualifyingEvidence(strategyId: string): StrategyEvidence {
    return {
      ...emptyEvidence(strategyId),
      dataQualityPass: true,
      qualityStatus: 'GREEN',
      parquetBytesWritten: true,
      backtestPass: true,
      oosPass: true,
      walkForwardPass: true,
      monteCarloPass: true,
      permutationPass: true,
      sensitivityPass: true,
      costStressPass: true,
      paperTrades: researchSafety.minPaperTrades,
      paperSessions: researchSafety.minPaperSessions,
      paperExpectancyPositive: true,
      paperDrawdownWithinLimit: true,
      paperProfitFactorPass: true,
      paperCalendarDaysPass: true,
      dataProvenance: 'REAL_MARKET_DATA',
      executionModel: 'NEXT_BAR_OPEN',
      organicPaperOnly: true,
    };
  }

  function sufficientSamples(): CertificationSamples {
    return {
      backtestTrades: researchSafety.minOosTrades,
      oosTrades: researchSafety.minOosTrades,
      walkForwardWindows: researchSafety.minWalkForwardWindows,
    };
  }

  const review = (targetStatus: BridgeTargetStatus): OperatorReview => ({
    reviewer: 'test-operator@example.invalid',
    decidedAt: new Date().toISOString(),
    statement: 'Synthetic certification fixture review: evidence package inspected, gates verified against config thresholds.',
    targetStatus,
  });

  const quantIdea = (strategyId: string) => ({
    origin: 'QUANT_STRATEGY',
    strategyId,
    agent: 'QuantEngine',
  });

  it('insufficient evidence -> no authority; only an explicit UNTESTED baseline is recordable', async () => {
    const evidence = { ...qualifyingEvidence(INSUFFICIENT_ID), backtestPass: true };
    // 5 closed trades: far below the researchSafety minimum sample — the "pass" must not count.
    const samples: CertificationSamples = { backtestTrades: 5, oosTrades: 0, walkForwardWindows: 0 };
    const a = bridge.evaluateCertification(INSUFFICIENT_ID, evidence, samples, provenance('insufficient'));
    expect(a.failClosed).toBe(false);
    expect(a.eligibleTarget).toBe('UNTESTED');
    expect(a.gates.find((g) => g.gate === 'BACKTEST_PASS_SUFFICIENT')?.pass).toBe(false);

    // The workflow cannot mint authority from thin evidence: the only permitted transition
    // is the explicit UNTESTED baseline, which keeps the consensus path.
    const reviewed = bridge.applyOperatorReview(a, review('UNTESTED'));
    const exec = await bridge.executeCertificationTransition(reviewed);
    expect(exec.newStatus).toBe('UNTESTED');
    expect(await eligibility.getStrategyLifecycleStatus(INSUFFICIENT_ID)).toBe('UNTESTED');
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea(INSUFFICIENT_ID));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('STRATEGY_UNTESTED');
  });

  it('bad OOS -> no authority (SHADOW at most)', async () => {
    const evidence = { ...qualifyingEvidence(BAD_OOS_ID), oosPass: false };
    const a = bridge.evaluateCertification(BAD_OOS_ID, evidence, sufficientSamples(), provenance('bad-oos'));
    expect(a.eligibleTarget).toBe('SHADOW');
    expect(a.gates.find((g) => g.gate === 'OOS_PASS_SUFFICIENT')?.pass).toBe(false);

    const reviewed = bridge.applyOperatorReview(a, review('SHADOW'));
    await bridge.executeCertificationTransition(reviewed);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea(BAD_OOS_ID));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('STRATEGY_SHADOW');
  });

  it('good backtest + poor walk-forward -> no authority (CANDIDATE at most)', async () => {
    const evidence = { ...qualifyingEvidence(POOR_WF_ID), walkForwardPass: false };
    const a = bridge.evaluateCertification(POOR_WF_ID, evidence, sufficientSamples(), provenance('poor-wf'));
    expect(a.eligibleTarget).toBe('CANDIDATE');
    expect(a.gates.find((g) => g.gate === 'WALK_FORWARD_SUFFICIENT')?.pass).toBe(false);

    const reviewed = bridge.applyOperatorReview(a, review('CANDIDATE'));
    await bridge.executeCertificationTransition(reviewed);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea(POOR_WF_ID));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('STRATEGY_CANDIDATE');
  });

  it('RETIRED strategy -> no authority; PULLBACK_CONTINUATION stays retired', async () => {
    expect(RETIRED_ID).toBe('PULLBACK_CONTINUATION');
    // Record the terminal decision through the EXISTING legitimate path (isolated DB only).
    await eligibility.quarantineStrategyForEmission(
      RETIRED_ID,
      'CERTIFICATION_FIXTURE_ONLY synthetic retirement: negative evidence finding',
      { fixture: 'SYNTHETIC_SEEDED' },
      22,
    );
    expect(await eligibility.getStrategyLifecycleStatus(RETIRED_ID)).toBe('RETIRED');

    // Even fully qualifying fresh evidence cannot promote a retired strategy via the bridge:
    // the assessment itself is fail-closed on retired research evidence...
    const retiredEvidence = { ...qualifyingEvidence(RETIRED_ID), retired: true };
    const a1 = bridge.evaluateCertification(RETIRED_ID, retiredEvidence, sufficientSamples(), provenance('retired-evidence'));
    expect(a1.failClosed).toBe(true);
    expect(a1.eligibleTarget).toBe('NONE');
    expect(() => bridge.applyOperatorReview(a1, review('VALIDATED'))).toThrow(/NOT_QUALIFIED/);

    // ...and even clean evidence (not marked retired) cannot execute while the recorded
    // runtime status is RETIRED: reversal requires the explicit reinstatement path.
    const a2 = bridge.evaluateCertification(RETIRED_ID, qualifyingEvidence(RETIRED_ID), sufficientSamples(), provenance('retired-current'));
    expect(a2.eligibleTarget).toBe('VALIDATED'); // evidence qualifies; the recorded status blocks
    const reviewed = bridge.applyOperatorReview(a2, review('VALIDATED'));
    await expect(bridge.executeCertificationTransition(reviewed)).rejects.toThrow(/TERMINAL_STATUS_REQUIRES_REINSTATEMENT/);

    // PULLBACK_CONTINUATION stays retired: terminally ineligible, never re-routed.
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea(RETIRED_ID));
    expect(r.authority).toBe('NOT_ELIGIBLE');
    expect(r.reason).toBe('STRATEGY_RETIRED');
    expect(await eligibility.hasStrategyLifecycleRecord(RETIRED_ID)).toBe(true);
    // The refused bridge execution recorded nothing: only the quarantine row exists.
    expect(await eligibility.getStrategyLifecycleHistory(RETIRED_ID)).toHaveLength(1);
  });

  it('legitimate reviewed qualification -> VALIDATED recorded by the workflow (isolated DB) -> AUTHORIZED_QUANT_POLICY', async () => {
    expect(await eligibility.hasStrategyLifecycleRecord(QUALIFIED_ID)).toBe(false);
    const a = bridge.evaluateCertification(QUALIFIED_ID, qualifyingEvidence(QUALIFIED_ID), sufficientSamples(), provenance('qualified'));
    expect(a.failClosed).toBe(false);
    expect(a.eligibleTarget).toBe('VALIDATED');
    expect(a.gates.every((g) => g.pass)).toBe(true);

    // The ONLY VALIDATED row in this file is recorded here, BY THE WORKFLOW UNDER TEST,
    // into the isolated temp DB — never seeded as a shortcut, never the production DB.
    const opReview = review('VALIDATED');
    const reviewed = bridge.applyOperatorReview(a, opReview);
    const exec = await bridge.executeCertificationTransition(reviewed);
    expect(exec.oldStatus).toBe('UNTESTED');
    expect(exec.newStatus).toBe('VALIDATED');
    expect(typeof exec.transitionId).toBe('string');

    // The recorded row carries the full audit payload the task requires.
    const history = await eligibility.getStrategyLifecycleHistory(QUALIFIED_ID);
    expect(history).toHaveLength(1);
    const payload = history[0].evidence as Record<string, unknown>;
    expect(payload.strategyId).toBe(QUALIFIED_ID);
    expect(payload.oldStatus).toBe('UNTESTED');
    expect(payload.newStatus).toBe('VALIDATED');
    expect(payload.evidenceIds).toEqual(provenance('qualified').evidenceIds);
    expect(payload.evidenceScope).toContain('CERTIFICATION_FIXTURE_ONLY');
    expect(payload.sampleSize).toBe(researchSafety.minOosTrades);
    expect(payload.oosResult).toMatchObject({ pass: true, trades: researchSafety.minOosTrades });
    expect(payload.walkForwardResult).toMatchObject({ pass: true, windows: researchSafety.minWalkForwardWindows });
    expect(payload.reviewer).toBe(opReview.reviewer);
    expect(payload.reviewedAt).toBe(opReview.decidedAt);
    expect(payload.reason).toBe(a.reason);
    expect(typeof payload.buildVersion).toBe('string');
    expect(typeof payload.assessedAt).toBe('string');
    expect(typeof payload.executedAt).toBe('string');

    // The REAL resolver grants AI-independent authority from the recorded row.
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea(QUALIFIED_ID));
    expect(r.authority).toBe('AUTHORIZED_QUANT_POLICY');
    expect(r.reason).toBe('STRATEGY_VALIDATED');
    expect(r.lifecycleStatus).toBe('VALIDATED');
  });

  it('ACTIVE_EXPLORATION keeps the consensus path (emission eligibility != execution authority)', async () => {
    // Research side fully green, but organic paper evidence still accumulating.
    const evidence = {
      ...qualifyingEvidence(EXPLORATION_ID),
      paperTrades: 3,
      paperSessions: 1,
      paperCalendarDaysPass: false,
    };
    const a = bridge.evaluateCertification(EXPLORATION_ID, evidence, sufficientSamples(), provenance('exploration'));
    expect(a.eligibleTarget).toBe('ACTIVE_EXPLORATION');
    expect(a.gates.find((g) => g.gate === 'PAPER_TRADES')?.pass).toBe(false);

    const reviewed = bridge.applyOperatorReview(a, review('ACTIVE_EXPLORATION'));
    await bridge.executeCertificationTransition(reviewed);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea(EXPLORATION_ID));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('STRATEGY_ACTIVE_EXPLORATION');
  });

  it('missing operator review -> no transition, no authority (type-level + runtime gate)', async () => {
    const a = bridge.evaluateCertification(QUALIFIED_ID, qualifyingEvidence(QUALIFIED_ID), sufficientSamples(), provenance('no-review'));
    expect(a.eligibleTarget).toBe('VALIDATED');

    // Empty reviewer identity: refused.
    expect(() => bridge.applyOperatorReview(a, { ...review('VALIDATED'), reviewer: '  ' })).toThrow(/OPERATOR_REVIEW_REQUIRED/);
    // Invalid timestamp: refused.
    expect(() => bridge.applyOperatorReview(a, { ...review('VALIDATED'), decidedAt: 'not-a-date' })).toThrow(/OPERATOR_REVIEW_REQUIRED/);
    // Missing rationale: refused.
    expect(() => bridge.applyOperatorReview(a, { ...review('VALIDATED'), statement: 'ok' })).toThrow(/OPERATOR_REVIEW_REQUIRED/);
    // Operator may not approve a status the evidence does not support.
    const shadowAssessment = bridge.evaluateCertification(BAD_OOS_ID, { ...qualifyingEvidence(BAD_OOS_ID), oosPass: false }, sufficientSamples(), provenance('mismatch'));
    expect(() => bridge.applyOperatorReview(shadowAssessment, review('VALIDATED'))).toThrow(/TARGET_MISMATCH/);
    // A forged "reviewed" object (no brand — the type-level gate made real at runtime): refused.
    const forged = { assessment: a, review: review('VALIDATED') };
    expect(() => bridge.validateReviewedCertification(forged)).toThrow(/NOT_REVIEWED/);
    await expect(bridge.executeCertificationTransition(forged as never)).rejects.toThrow(/NOT_REVIEWED/);

    // None of the refused reviews recorded anything: QUALIFIED_ID still carries only the
    // single VALIDATED row recorded by the legitimate workflow earlier in this file.
    expect(await eligibility.getStrategyLifecycleHistory(QUALIFIED_ID)).toHaveLength(1);
  });

  it('LIVE authority is impossible: inexpressible in the bridge vocabulary and denied by the env lock', async () => {
    const a = bridge.evaluateCertification(QUALIFIED_ID, qualifyingEvidence(QUALIFIED_ID), sufficientSamples(), provenance('live-impossible'));
    // The research-side LIVE vocabulary cannot be named as a bridge target: the review
    // validator rejects it before any brand is minted.
    const liveReview = { ...review('VALIDATED'), targetStatus: 'LIVE_APPROVED' } as unknown as OperatorReview;
    expect(() => bridge.applyOperatorReview(a, liveReview)).toThrow(/INVALID_TARGET/);

    // Belt and suspenders: even the legitimately recorded VALIDATED row grants nothing
    // once the paper-only environment lock is off (the authorization layer's own rule).
    process.env.PAPER_TRADING_ONLY = 'false';
    try {
      const r = await authz.resolveQuantStrategyAuthorization(quantIdea(QUALIFIED_ID));
      expect(r.authority).toBe('NOT_ELIGIBLE');
      expect(r.reason).toBe('ENVIRONMENT_NOT_AUTHORIZED');
    } finally {
      process.env.PAPER_TRADING_ONLY = 'true';
    }
    // And the lock back on: authority is PAPER-only, as designed.
    const r2 = await authz.resolveQuantStrategyAuthorization(quantIdea(QUALIFIED_ID));
    expect(r2.authority).toBe('AUTHORIZED_QUANT_POLICY');
  });

  it('CHAMPION requires a currently-VALIDATED strategy (comparative promotion only)', async () => {
    // QUALIFIED_ID is VALIDATED in this isolated DB (recorded by the workflow above), but
    // the assessment's eligible target is VALIDATED, not CHAMPION: the operator cannot
    // jump the ladder by approving a status the evidence does not support.
    const a = bridge.evaluateCertification(QUALIFIED_ID, qualifyingEvidence(QUALIFIED_ID), sufficientSamples(), provenance('champion'));
    expect(a.failClosed).toBe(false);
    expect(a.eligibleTarget).toBe('VALIDATED');
    expect(() => bridge.applyOperatorReview(a, { ...review('CHAMPION'), targetStatus: 'CHAMPION' })).toThrow(/TARGET_MISMATCH/);

    // The execution-time CHAMPION_REQUIRES_VALIDATED check is defense-in-depth behind the
    // review gate: it can only be reached by a branded review whose assessment claims
    // CHAMPION, which the public path above proves unmintable. Unreviewed input is
    // refused first, by design.
    const forgedReviewed = {
      assessment: { ...a, eligibleTarget: 'CHAMPION' as never },
      review: { ...review('VALIDATED'), targetStatus: 'CHAMPION' as never },
    };
    await expect(bridge.executeCertificationTransition(forgedReviewed as never)).rejects.toThrow(/NOT_REVIEWED/);
  });

  it('assessment is structurally incapable of writing: exactly one recordStrategyLifecycleTransition call site in the module', () => {
    // Mirrors the Layer-3 probe pattern: strip comments, count real call sites of the
    // recorder in the bridge module. evaluateCertification/applyOperatorReview must never
    // gain a write path; only executeCertificationTransition() holds it.
    const src = fs.readFileSync(path.join(__dirname, 'certificationBridge.ts'), 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    const calls = stripped.match(/recordStrategyLifecycleTransition\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // And the single call site lives inside executeCertificationTransition.
    const execIdx = stripped.indexOf('export async function executeCertificationTransition');
    const callIdx = stripped.indexOf('recordStrategyLifecycleTransition(');
    expect(execIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(execIdx);
  });
});
