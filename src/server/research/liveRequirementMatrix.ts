/**
 * A–Z LIVE requirement catalog. Status is derived from code + evidence files, never invented PASS.
 * LIVE_READY still requires evaluateLiveReadiness().failedMandatory.length === 0.
 */
import { researchSafety } from '../config/researchSafety';
import { quantExperimentalStrategies } from '../config/quantExperimentalStrategies';
import { deriveLifecycleStatus, emptyEvidence, liveGoNoGo, type StrategyEvidence } from './promotionEngine';
import { loadBaselineEvidenceIndex, loadPersistedEvidenceForStrategy } from './researchRuns';

export type RequirementStatus = 'IMPLEMENTED' | 'PARTIALLY_IMPLEMENTED' | 'MISSING' | 'BROKEN' | 'UNVERIFIED';
export type PromotionClass = 'PROMOTE' | 'CONTINUE_PAPER' | 'RESEARCH_ONLY' | 'RETIRE';

export interface LiveRequirementRow {
  category: string;
  id: string;
  requirement: string;
  status: RequirementStatus;
  file: string;
  evidence: string;
  requiredAction: string;
}

export interface StrategyBoardRow {
  strategyId: string;
  family: 'CORE' | 'EXPERIMENTAL';
  lifecycle: string;
  live: 'GO' | 'NO-GO';
  backtest: boolean | null;
  oos: boolean | null;
  wfo: boolean | null;
  monteCarlo: boolean | null;
  permutation: boolean | null;
  sensitivity: boolean | null;
  costStress: boolean | null;
  paperTrades: number;
  paperSessions: number;
  oosTrades: number | null;
  oosExpectancy: number | null;
  fullStrategyParity: boolean | null;
  classification: PromotionClass;
  note: string;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function coerceEvidence(strategyId: string, raw: StrategyEvidence | null | undefined): StrategyEvidence {
  if (!raw) return emptyEvidence(strategyId);
  return { ...emptyEvidence(strategyId), ...raw, strategyId };
}

export function classifyStrategy(opts: {
  family: 'CORE' | 'EXPERIMENTAL';
  evidence: StrategyEvidence;
  oosTrades: number | null;
  oosExpectancy: number | null;
}): { classification: PromotionClass; note: string } {
  const { live } = liveGoNoGo(opts.evidence);
  if (live === 'GO') return { classification: 'PROMOTE', note: 'All promotion gates passed including manual approval.' };
  if (opts.family === 'EXPERIMENTAL') {
    return { classification: 'RESEARCH_ONLY', note: 'Experimental / UNVALIDATED. Not a LIVE candidate.' };
  }
  const n = opts.oosTrades;
  const exp = opts.oosExpectancy;
  if (
    typeof n === 'number'
    && n >= researchSafety.minOosTrades
    && typeof exp === 'number'
    && exp < researchSafety.minOosExpectancy
  ) {
    return {
      classification: 'RETIRE',
      note: `OOS n=${n} expectancy ${exp.toFixed(4)} < minOosExpectancy ${researchSafety.minOosExpectancy}. Do not promote this version.`,
    };
  }
  if (opts.evidence.walkForwardPass && opts.evidence.oosPass && opts.evidence.backtestPass) {
    return { classification: 'CONTINUE_PAPER', note: 'Research gates incomplete or paper floors unmet. Paper soak only.' };
  }
  if (opts.evidence.oosPass && !opts.evidence.walkForwardPass) {
    return { classification: 'CONTINUE_PAPER', note: 'OOS flagged pass but WFO/robustness failed. Paper evidence only — not LIVE_ELIGIBLE.' };
  }
  return { classification: 'RESEARCH_ONLY', note: 'Insufficient OOS/WFO/robustness. Keep in research until a new version clears gates.' };
}

export function buildStrategyBoard(): StrategyBoardRow[] {
  const baseline = loadBaselineEvidenceIndex();
  const byId = new Map((baseline?.strategies ?? []).map((s) => [s.strategyId, s]));
  const rows: StrategyBoardRow[] = [];

  for (const strategyId of researchSafety.coreStrategyIds) {
    const snap = byId.get(strategyId);
    const evidence = coerceEvidence(strategyId, loadPersistedEvidenceForStrategy(strategyId) ?? snap?.evidence);
    const oosTrades = asFiniteNumber(snap?.gateSnapshot.oosTrades);
    const oosExpectancy = asFiniteNumber(snap?.gateSnapshot.oosExpectancy);
    const cls = classifyStrategy({ family: 'CORE', evidence, oosTrades, oosExpectancy });
    rows.push({
      strategyId,
      family: 'CORE',
      lifecycle: deriveLifecycleStatus(evidence),
      live: liveGoNoGo(evidence).live,
      backtest: evidence.backtestPass,
      oos: evidence.oosPass,
      wfo: evidence.walkForwardPass,
      monteCarlo: evidence.monteCarloPass,
      permutation: evidence.permutationPass,
      sensitivity: evidence.sensitivityPass,
      costStress: evidence.costStressPass,
      paperTrades: evidence.paperTrades,
      paperSessions: evidence.paperSessions,
      oosTrades,
      oosExpectancy,
      fullStrategyParity: asBoolean(snap?.gateSnapshot.fullStrategyParity),
      classification: cls.classification,
      note: cls.note,
    });
  }

  const experimentalIds = [
    ...new Set([
      ...researchSafety.experimentalStrategyIds,
      ...quantExperimentalStrategies.strategies.map((s) => s.id),
    ]),
  ];
  for (const strategyId of experimentalIds) {
    rows.push({
      strategyId,
      family: 'EXPERIMENTAL',
      lifecycle: 'UNTESTED',
      live: 'NO-GO',
      backtest: null,
      oos: null,
      wfo: null,
      monteCarlo: null,
      permutation: null,
      sensitivity: null,
      costStress: null,
      paperTrades: 0,
      paperSessions: 0,
      oosTrades: null,
      oosExpectancy: null,
      fullStrategyParity: false,
      classification: 'RESEARCH_ONLY',
      note: 'Experimental. Live evaluateAll only if that strategy env var is the string true. Not LIVE-eligible.',
    });
  }
  return rows;
}

/** Fail-closed A–Z catalog. UNAVAILABLE/FAIL is not a silent PASS. */
export function buildLiveRequirementMatrix(): LiveRequirementRow[] {
  return [
    { category: 'A. SOFTWARE ENGINEERING', id: 'A_SPINE', requirement: 'Single EventBus → ChiefTrader → RiskEngine → OMS → Broker placeOrder', status: 'IMPLEMENTED', file: 'src/server/services/OrderManagement.ts', evidence: 'phase21 file-scan: no second production .placeOrder', requiredAction: 'Keep invariant test. Do not add UI/MCP placeOrder.' },
    { category: 'A. SOFTWARE ENGINEERING', id: 'A_TESTS', requirement: 'tsc + vitest green on every promotion candidate', status: 'PARTIALLY_IMPLEMENTED', file: 'package.json', evidence: 'Vitest exists; not evaluated inside liveReadinessEngine process', requiredAction: 'CI gate required before LIVE_ARM. Do not treat local green as standing LIVE_READY.' },
    { category: 'B. EXECUTION SAFETY', id: 'B_PAPER_LOCK', requirement: 'PAPER_TRADING_ONLY demotes LIVE; LIVE_ARM required for live host', status: 'IMPLEMENTED', file: 'src/server/core/LiveTradingConfirmation.ts', evidence: 'Alpaca live host + OMS assertLiveOrdersArmed', requiredAction: 'Leave PAPER_TRADING_ONLY=true until every promotion gate PASSes.' },
    { category: 'B. EXECUTION SAFETY', id: 'B_DUAL_FLAG', requirement: 'tradingMode and broker paperMode must agree or UNKNOWN fail-closed', status: 'IMPLEMENTED', file: 'src/server/core/brokerEnvironment.ts', evidence: 'liveReadiness.test.ts', requiredAction: 'None — do not infer LIVE from one flag.' },
    { category: 'C. RISK MANAGEMENT', id: 'C_GATES', requirement: 'All catalog RiskEngine gates recorded; fail-closed stale/clock/equity', status: 'IMPLEMENTED', file: 'src/server/engines/RiskEngine.ts', evidence: 'config/riskGateOrder.json + RiskEngine.test.ts', requiredAction: 'Do not skip gates to raise fill rate.' },
    { category: 'D. MARKET DATA', id: 'D_FRESHNESS', requirement: 'Null quote age is UNKNOWN fail-closed; WS reconnect exists', status: 'PARTIALLY_IMPLEMENTED', file: 'src/server/core/marketDataQuality.ts', evidence: 'data_freshness tests; live WS certificate UNAVAILABLE in-process', requiredAction: 'Certify Alpaca IEX WS at open for soak; 5min stale threshold is coarse (P2).' },
    { category: 'E. BROKER INTEGRATION', id: 'E_ALPACA_PAPER', requirement: 'Alpaca paper-api is the paper order host', status: 'IMPLEMENTED', file: 'src/brokers/AlpacaBroker.ts', evidence: 'paperTrading() sets paper-api.alpaca.markets', requiredAction: 'Do not select IBKR (Gateway account ≠ Argus paperMode).' },
    { category: 'E. BROKER INTEGRATION', id: 'E_LIVE_KEYS', requirement: 'Live Alpaca host must remain unreachable until dual confirm + arm', status: 'IMPLEMENTED', file: 'src/brokers/AlpacaBroker.ts', evidence: 'placeOrder live host asserts LIVE_ARM', requiredAction: 'Separate LIVE keys/account; never reuse paper keys on live host.' },
    { category: 'F. OMS', id: 'F_PENDING_FIRST', requirement: 'PENDING row before broker; throw is UNKNOWN not guessed REJECTED', status: 'IMPLEMENTED', file: 'src/server/services/OrderManagement.ts', evidence: 'OrderManagement.test.ts + crashRecovery.test.ts', requiredAction: 'OMS_HEALTH promotion flag stays false until a paper soak with zero unknown orphans.' },
    { category: 'G. RECONCILIATION', id: 'G_PAUSE', requirement: 'Material mismatch pauses TRADING_PAUSED', status: 'IMPLEMENTED', file: 'src/server/services/PortfolioReconciliation.ts', evidence: 'kill_switch_events recon pauses', requiredAction: 'Clear DIAG PENDING ghosts; do not disable recon. Flag stays uncertified until soak without pause loops.' },
    { category: 'H. DATABASE/PERSISTENCE', id: 'H_ENV_COL', requirement: 'trades.execution_environment + organic classifier', status: 'IMPLEMENTED', file: 'src/server/research/organicPaper.ts', evidence: 'integrity_check ok; organic count 0', requiredAction: 'Preserve stamps. Replay/EXTERNAL_SYNC/DIAG never count as PAPER.' },
    { category: 'I. OBSERVABILITY', id: 'I_TRACE', requirement: 'traceId through risk_assessments, trades, fills', status: 'PARTIALLY_IMPLEMENTED', file: 'src/server/engines/RiskEngine.ts', evidence: 'gates persist; dashboards still have honest-empty panels', requiredAction: 'Observability PASS only after a full paper round-trip reconstructs end-to-end.' },
    { category: 'J. SECURITY', id: 'J_AUTH', requirement: 'AUTH_PASSWORD; production refuses unauthenticated boot', status: 'PARTIALLY_IMPLEMENTED', file: 'src/server/core/AuthConfig.ts', evidence: 'AuthConfig.test.ts', requiredAction: 'Security PASS is operator-certified (secrets, bind, session). Not auto-PASS.' },
    { category: 'K. AI AGENTS', id: 'K_NO_EXECUTE', requirement: 'AI cannot placeOrder; invented numerics nulled', status: 'IMPLEMENTED', file: 'src/server/services/RiskAgent.ts', evidence: 'phase21 UI/python no BrokerManager.placeOrder', requiredAction: 'Keep parseResearchNote nulling. AI is evidence, not a calibrated win rate.' },
    { category: 'L. STRATEGY ENGINE', id: 'L_CORE_FIVE', requirement: 'Live evaluateAll is five CORE unless experimental env true', status: 'IMPLEMENTED', file: 'src/server/quant/strategies/StrategyEngine.ts', evidence: 'experimentalDaytradeStrategies.test.ts', requiredAction: 'Do not enable experimental env vars to “see if it works”.' },
    { category: 'M. HISTORICAL RESEARCH', id: 'M_WAREHOUSE', requirement: 'GREEN parquet REAL_MARKET_DATA for promotion', status: 'PARTIALLY_IMPLEMENTED', file: 'src/server/research/warehouseInventory.ts', evidence: 'Some GREEN datasets exist; CORE not VALIDATED', requiredAction: 'Re-run canonical research after strategy/version change.' },
    { category: 'N. POINT-IN-TIME DATA', id: 'N_CUTOFF', requirement: 'Replay InformationCutoff; newsVisibleAt', status: 'PARTIALLY_IMPLEMENTED', file: 'src/server/replay/InformationCutoff.ts', evidence: 'MODE B exists; live agents not PIT-logged historically', requiredAction: 'Persist PIT agent/news logs going forward. Cannot fabricate 2022 debates.' },
    { category: 'O. BACKTESTING', id: 'O_NEXT_BAR', requirement: 'Canonical fill NEXT_BAR_OPEN; SAME_BAR_CLOSE not promotable', status: 'IMPLEMENTED', file: 'src/server/research/executionModel.ts', evidence: 'assertPromotionQuarantine', requiredAction: 'Keep quarantine.' },
    { category: 'P. OOS VALIDATION', id: 'P_OOS', requirement: `OOS n≥${researchSafety.minOosTrades} and expectancy≥${researchSafety.minOosExpectancy}`, status: 'BROKEN', file: 'data/research/runs/baseline_index.json', evidence: 'CORE oosPass mostly false; RANGE_REVERSION OOS expectancy negative at n=148', requiredAction: 'New strategy versions; do not promote current CORE ids.' },
    { category: 'Q. WALK-FORWARD', id: 'Q_WFO', requirement: `≥${researchSafety.minWalkForwardWindows} windows; median test expectancy ≥ 0`, status: 'BROKEN', file: 'data/research/runs/baseline_index.json', evidence: 'walkForwardPass false; wfoStatus FRAGILE', requiredAction: 'Pass purged/embargo WFO on REAL_MARKET_DATA before PAPER_TESTING lifecycle.' },
    { category: 'R. MONTE CARLO', id: 'R_MC', requirement: 'MC path-wise drawdown within research cap', status: 'BROKEN', file: 'src/server/quant/analysis/MonteCarlo.ts', evidence: 'baseline monteCarloPass false', requiredAction: 'Re-run robustness on a strategy that already has OOS+WFO pass.' },
    { category: 'S. PERMUTATION', id: 'S_PERM', requirement: `Permutation p < ${researchSafety.permutationAlpha}`, status: 'BROKEN', file: 'src/server/research/robustness.ts', evidence: 'baseline permutationPass false', requiredAction: 'Reject strategies indistinguishable from shuffled returns.' },
    { category: 'T. SENSITIVITY', id: 'T_SENS', requirement: 'Parameter neighborhood remains profitable', status: 'BROKEN', file: 'src/server/research/robustness.ts', evidence: 'Most CORE sensitivityPass false', requiredAction: 'Do not tune to a single in-sample peak.' },
    { category: 'U. COST/SLIPPAGE STRESS', id: 'U_COST', requirement: `Still profitable at ${researchSafety.costStressMaxMultipleStillProfitable}x research costs`, status: 'BROKEN', file: 'config/researchSafety.json', evidence: 'commissionPerShare/spreadBps/slippageBps set; CORE costStress mostly fail', requiredAction: 'Zero-cost research cannot promote (zeroCostBlocksPromotion).' },
    { category: 'V. PAPER TRADING', id: 'V_ORGANIC', requirement: `≥${researchSafety.minPaperTrades} organic FILLED SELL P&L; ≥${researchSafety.minPaperSessions} sessions; ≥${researchSafety.minPaperCalendarDays} NY days; PF≥${researchSafety.minPaperProfitFactor}; expectancy>0; DD≤${researchSafety.maxPaperDrawdownPct}`, status: 'MISSING', file: 'src/server/research/organicPaper.ts', evidence: 'organic closed count 0', requiredAction: 'Run Autobot on Alpaca PAPER. Exclude REPLAY/EXTERNAL_SYNC/DIAG/OVERRIDE.' },
    { category: 'W. OPERATIONAL SOAK', id: 'W_SOAK', requirement: 'Multi-day Autobot session without recon pause loops', status: 'MISSING', file: 'src/server/services/PortfolioReconciliation.ts', evidence: 'Day-1 soak never started (Autobot off, Sunday)', requiredAction: 'Monday open checklist; archive DIAG ghosts first.' },
    { category: 'X. FAILURE RECOVERY', id: 'X_CRASH', requirement: 'OMS crash recovery + restart LIVE_ARM fail-closed', status: 'PARTIALLY_IMPLEMENTED', file: 'src/server/services/OrderManagement.ts', evidence: 'crashRecovery tests; empirical soak UNVERIFIED', requiredAction: 'Inject disconnect/restart during paper soak and record recovery.' },
    { category: 'Y. LIVE BROKER VERIFICATION', id: 'Y_LIVE_ACCT', requirement: 'Dedicated LIVE account, 2FA, tiny notional, RestrictedLiveMode', status: 'MISSING', file: 'src/server/engines/RestrictedLiveMode.ts', evidence: 'Caps exist; LIVE still NO-GO', requiredAction: 'Only after LIVE_CANDIDATE. Separate keys. Dual confirm phrase.' },
    { category: 'Z. MANUAL APPROVAL', id: 'Z_HUMAN', requirement: 'Human ENABLE LIVE TRADING + written sign-off', status: 'IMPLEMENTED', file: 'src/server/core/LiveTradingConfirmation.ts', evidence: 'Phrase gate + restart clears arm', requiredAction: 'Never auto-arm. Manual approval is last, not first.' },
  ];
}

export function liveEligibilityFromMatrix(rows: LiveRequirementRow[]): {
  engineeringCapableOfLiveExecution: boolean;
  empiricallyJustifiedToRiskCapital: boolean;
  liveEligibility: 'PASS' | 'FAIL';
} {
  const empiricalIds = ['P_OOS', 'Q_WFO', 'R_MC', 'S_PERM', 'T_SENS', 'U_COST', 'V_ORGANIC', 'W_SOAK'];
  const engineeringCapable = rows
    .filter((r) => r.category.startsWith('A.') || r.category.startsWith('B.') || r.category.startsWith('C.') || r.category.startsWith('F.'))
    .every((r) => r.status === 'IMPLEMENTED' || r.status === 'PARTIALLY_IMPLEMENTED');
  const empiricallyJustified = empiricalIds.every((id) => rows.find((r) => r.id === id)?.status === 'IMPLEMENTED');
  return {
    engineeringCapableOfLiveExecution: engineeringCapable,
    empiricallyJustifiedToRiskCapital: empiricallyJustified,
    liveEligibility: empiricallyJustified ? 'PASS' : 'FAIL',
  };
}
