/**
 * Authoritative LIVE readiness. LIVE_READY only if every mandatory gate is PASS.
 * Current Argus evidence cannot satisfy that. This engine must not invent PASS.
 */
import { canadianMarketReadiness } from '../markets/canadianReadiness';
import { emptyEvidence, deriveLifecycleStatus, liveGoNoGo } from '../research/promotionEngine';
import { researchSafety, isTheoreticalZeroCost } from '../config/researchSafety';
import { tradingEdgeScore } from '../research/edgeScore';

export type ReadinessVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNAVAILABLE';

export interface LiveReadinessGate {
  id: string;
  category: string;
  verdict: ReadinessVerdict;
  detail: string;
  mandatory: boolean;
}

export interface LiveReadinessReport {
  result: 'LIVE_READY' | 'LIVE_NO_GO';
  tradingEdgeScore: number;
  organicPaper: 'NOT_ESTABLISHED';
  canadianLive: 'NOT_AVAILABLE';
  quantEngineDefault: 'OFF' | 'ON';
  gates: LiveReadinessGate[];
  failedMandatory: string[];
  canPlaceOrdersViaResearch: false;
}

function gate(id: string, category: string, verdict: ReadinessVerdict, detail: string, mandatory = true): LiveReadinessGate {
  return { id, category, verdict, detail, mandatory };
}

export function evaluateLiveReadiness(): LiveReadinessReport {
  const e = emptyEvidence('MOMENTUM_BREAKOUT');
  const promo = liveGoNoGo(e);
  const edge = tradingEdgeScore(e);
  const ca = canadianMarketReadiness();
  const quantOn = process.env.QUANT_ENGINE_ENABLED === 'true';

  const gates: LiveReadinessGate[] = [
    gate('SOFTWARE_ORDER_PATH', 'SOFTWARE', 'PASS', 'Production .placeOrder is OMS + broker adapters only (file-scan invariant).'),
    gate('SOFTWARE_TESTS', 'SOFTWARE', 'UNAVAILABLE', 'CI/tsc/vitest are not evaluated inside this process. Last measured suite is not LIVE evidence.'),
    gate('EXECUTION_OMS', 'EXECUTION', 'PASS', 'OMS is the only production executeOrder path. Not proof of LIVE equity.'),
    gate('RISK_GATES', 'RISK', 'PASS', `RiskEngine records ${24} named gates. Presence is not profitability.`),
    gate('MARKET_DATA', 'MARKET DATA', 'UNAVAILABLE', 'Live tick health is runtime. Stale/missing price fail-closed in RiskEngine when a proposal is evaluated.'),
    gate('RESEARCH_WAREHOUSE', 'RESEARCH', 'UNAVAILABLE', 'No GREEN REAL_MARKET_DATA parquet is assumed present. Empty warehouse is not complete.'),
    gate('STRATEGY_CORE', 'STRATEGY', 'FAIL', `CORE strategies are ${deriveLifecycleStatus(e)}. ${researchSafety.coreStrategyIds.length} CORE ids in config; UNTESTED ≠ VALIDATED.`),
    gate('STRATEGY_SMC', 'STRATEGY', 'FAIL', 'SMC_LIQUIDITY_SWEEP is UNVALIDATED. Live evaluateAll excludes it unless env is true.'),
    gate('OOS', 'OOS', 'FAIL', 'REAL_MARKET_DATA OOS is NOT ESTABLISHED.'),
    gate('WFO', 'WFO', 'FAIL', 'CORE NEXT_BAR WFO is NOT ESTABLISHED. SAME_BAR WALKFORWARD_CHECK_RESULTS.json is quarantined.'),
    gate('ROBUSTNESS', 'ROBUSTNESS', 'FAIL', 'CORE robustness on real data is NOT ESTABLISHED.'),
    gate('STATISTICS', 'STATISTICS', 'UNAVAILABLE', 'No statistically justified CORE NEXT_BAR sample.'),
    gate('PAPER', 'PAPER', 'FAIL', 'Organic PAPER FILLED SELL P&L is NOT ESTABLISHED.'),
    gate('BROKER_LIVE_CONFIRM', 'BROKER', 'FAIL', 'LIVE requires explicit confirmation phrase. Dual paperMode/tradingMode can be UNKNOWN.'),
    gate('RECONCILIATION', 'RECONCILIATION', 'UNAVAILABLE', 'Mismatch pauses trading when a cycle runs; not a standing LIVE_READY certificate.'),
    gate('SECURITY', 'SECURITY', 'UNAVAILABLE', 'Encryption/auth exist; production AUTH_PASSWORD must be set. Not auto-PASS.'),
    gate('OBSERVABILITY', 'OBSERVABILITY', 'UNAVAILABLE', 'Traces exist on the live path. Dashboards may still show Awaiting Evidence.'),
    gate('RECOVERY', 'RECOVERY', 'UNAVAILABLE', 'OMS crash recovery exists; disaster recovery is not LIVE-certified.'),
    gate('OPERATIONS', 'OPERATIONS', 'UNAVAILABLE', 'No 24/7 operator certification in this engine.'),
    gate('LEGAL_CA', 'LEGAL/REGULATORY', 'BLOCKED', ca.banner),
    gate('MANUAL_APPROVAL', 'MANUAL APPROVAL', promo.live === 'GO' ? 'PASS' : 'FAIL', `promotion liveGoNoGo=${promo.live}. ${promo.failedGates.slice(0, 8).join(', ')}`),
    gate('ZERO_COST_RESEARCH', 'RESEARCH', isTheoreticalZeroCost() ? 'FAIL' : 'PASS', isTheoreticalZeroCost() ? 'Research costs are theoretical zero; cannot promote.' : 'Non-zero research costs configured.'),
    gate('QUANT_DEFAULT', 'STRATEGY', quantOn ? 'UNAVAILABLE' : 'PASS', quantOn ? 'QUANT_ENGINE_ENABLED=true does not imply VALIDATED.' : 'QUANT_ENGINE_ENABLED defaults off.'),
    gate('MIN_PAPER', 'PAPER', 'FAIL', `Need >= ${researchSafety.minPaperTrades} organic trades and ${researchSafety.minPaperSessions} sessions.`),
  ];

  const failedMandatory = gates.filter((g) => g.mandatory && g.verdict !== 'PASS').map((g) => g.id);
  return {
    result: failedMandatory.length === 0 ? 'LIVE_READY' : 'LIVE_NO_GO',
    tradingEdgeScore: edge.score,
    organicPaper: 'NOT_ESTABLISHED',
    canadianLive: 'NOT_AVAILABLE',
    quantEngineDefault: quantOn ? 'ON' : 'OFF',
    gates,
    failedMandatory,
    canPlaceOrdersViaResearch: false,
  };
}
