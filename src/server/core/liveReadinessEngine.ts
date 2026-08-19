/**
 * Authoritative LIVE readiness. LIVE_READY only if every mandatory gate is PASS.
 * Current Argus evidence cannot satisfy that. This engine must not invent PASS.
 */
import { canadianMarketReadiness } from '../markets/canadianReadiness';
import { emptyEvidence, deriveLifecycleStatus, liveGoNoGo } from '../research/promotionEngine';
import { researchSafety, isTheoreticalZeroCost } from '../config/researchSafety';
import { tradingEdgeScore } from '../research/edgeScore';
import { inspectResearchWarehouse } from '../research/warehouseInventory';
import { summarizeOrganicPaper } from '../research/organicPaper';
import {
  buildLiveRequirementMatrix,
  buildStrategyBoard,
  liveEligibilityFromMatrix,
  type LiveRequirementRow,
  type StrategyBoardRow,
} from '../research/liveRequirementMatrix';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { isRuntimeFlagEnabled } from '../config/effectiveRuntimeConfig';
import { db } from '../db';
import { trades } from '../db/schema';

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
  /** Engineering can route a LIVE order. That is not permission to risk capital. */
  engineeringCapableOfLiveExecution: boolean;
  /** Research + organic paper + soak must all be IMPLEMENTED. Currently false. */
  empiricallyJustifiedToRiskCapital: boolean;
  liveEligibility: 'PASS' | 'FAIL';
  requirementMatrix: LiveRequirementRow[];
  strategyBoard: StrategyBoardRow[];
}

function gate(id: string, category: string, verdict: ReadinessVerdict, detail: string, mandatory = true): LiveReadinessGate {
  return { id, category, verdict, detail, mandatory };
}

function organicPaperSnapshot(): {
  closedTradeCount: number;
  sessionCount: number;
  expectancy: number | null;
  profitFactor: number | null;
  note: string;
} {
  try {
    const rows = db.select().from(trades).all();
    const s = summarizeOrganicPaper(rows, researchSafety.minPaperTrades);
    return {
      closedTradeCount: s.closedTradeCount,
      sessionCount: s.sessionCount,
      expectancy: s.expectancy,
      profitFactor: s.profitFactor,
      note: s.note,
    };
  } catch {
    return {
      closedTradeCount: 0,
      sessionCount: 0,
      expectancy: null,
      profitFactor: null,
      note: 'Organic paper query UNAVAILABLE. Counted as 0, not PASS.',
    };
  }
}

export function evaluateLiveReadiness(): LiveReadinessReport {
  const e = emptyEvidence('MOMENTUM_BREAKOUT');
  const promo = liveGoNoGo(e);
  const edge = tradingEdgeScore(e);
  const ca = canadianMarketReadiness();
  const quantOn = isRuntimeFlagEnabled('QUANT_ENGINE_ENABLED');
  const paper = organicPaperSnapshot();
  const paperCountFloorsMet =
    paper.closedTradeCount >= researchSafety.minPaperTrades
    && paper.sessionCount >= researchSafety.minPaperSessions;
  const paperProfitFactorPass =
    paper.profitFactor != null && paper.profitFactor >= researchSafety.minPaperProfitFactor;
  const paperExpectancyPass =
    paper.expectancy != null && paper.expectancy > researchSafety.minPaperExpectancy;
  const paperCalendarDaysPass = paper.sessionCount >= researchSafety.minPaperCalendarDays;
  const paperFloorsMet =
    paperCountFloorsMet && paperProfitFactorPass && paperExpectancyPass && paperCalendarDaysPass;
  const riskGateCount = loadRepoConfigJson<{ gates: string[] }>('riskGateOrder.json').gates.length;
  const requirementMatrix = buildLiveRequirementMatrix();
  const strategyBoard = buildStrategyBoard();
  const eligibility = liveEligibilityFromMatrix(requirementMatrix);

  const warehouse = inspectResearchWarehouse();
  const gates: LiveReadinessGate[] = [
    gate('SOFTWARE_ORDER_PATH', 'SOFTWARE', 'PASS', 'Production .placeOrder is OMS + broker adapters only (file-scan invariant).'),
    gate('SOFTWARE_TESTS', 'SOFTWARE', 'UNAVAILABLE', 'CI/tsc/vitest are not evaluated inside this process. Last measured suite is not LIVE evidence.'),
    gate('EXECUTION_OMS', 'EXECUTION', 'PASS', 'OMS is the only production executeOrder path. Not proof of LIVE equity.'),
    gate('RISK_GATES', 'RISK', 'PASS', `RiskEngine catalog has ${riskGateCount} named gates. Presence is not profitability.`),
    gate('MARKET_DATA', 'MARKET DATA', 'UNAVAILABLE', 'Quote age null is UNKNOWN and fails RiskEngine data_freshness. Standing LIVE_READY still requires a live feed certificate, which this process does not invent.'),
    gate('RESEARCH_WAREHOUSE', 'RESEARCH', warehouse.greenRealMarketData ? 'PASS' : 'UNAVAILABLE', warehouse.note),
    gate('STRATEGY_CORE', 'STRATEGY', 'FAIL', `CORE strategies are ${deriveLifecycleStatus(e)}. ${researchSafety.coreStrategyIds.length} CORE ids in config; UNTESTED ≠ VALIDATED.`),
    gate('STRATEGY_SMC', 'STRATEGY', 'FAIL', 'SMC_LIQUIDITY_SWEEP is UNVALIDATED. Live evaluateAll excludes it unless env is true.'),
    gate('OOS', 'OOS', 'FAIL', 'REAL_MARKET_DATA OOS is NOT ESTABLISHED.'),
    gate('WFO', 'WFO', 'FAIL', 'CORE NEXT_BAR WFO is NOT ESTABLISHED. SAME_BAR WALKFORWARD_CHECK_RESULTS.json is quarantined.'),
    gate('ROBUSTNESS', 'ROBUSTNESS', 'FAIL', 'CORE robustness on real data is NOT ESTABLISHED.'),
    gate('STATISTICS', 'STATISTICS', 'UNAVAILABLE', 'No statistically justified CORE NEXT_BAR sample.'),
    gate('PAPER', 'PAPER', paperFloorsMet ? 'PASS' : 'FAIL', `Organic PAPER FILLED SELL P&L: ${paper.closedTradeCount} trades / ${paper.sessionCount} NY sessions. ${paper.note}`),
    gate('BROKER_LIVE_CONFIRM', 'BROKER', 'FAIL', 'LIVE requires ENABLE LIVE TRADING to enable settings/broker mode, plus runtime LIVE_ARM for each process (OMS + live Alpaca host). Dual paperMode/tradingMode alone is UNKNOWN or insufficient after restart. Not a LIVE_READY certificate.'),
    gate('RECONCILIATION', 'RECONCILIATION', 'UNAVAILABLE', 'Mismatch pauses trading when a cycle runs; not a standing LIVE_READY certificate.'),
    gate('SECURITY', 'SECURITY', 'UNAVAILABLE', 'Encryption/auth exist; production AUTH_PASSWORD must be set. Not auto-PASS.'),
    gate('OBSERVABILITY', 'OBSERVABILITY', 'UNAVAILABLE', 'Traces exist on the live path. Dashboards may still show Awaiting Evidence.'),
    gate('RECOVERY', 'RECOVERY', 'UNAVAILABLE', 'OMS crash recovery exists; disaster recovery is not LIVE-certified.'),
    gate('OPERATIONS', 'OPERATIONS', 'UNAVAILABLE', 'No 24/7 operator certification in this engine.'),
    gate('LEGAL_CA', 'LEGAL/REGULATORY', 'BLOCKED', ca.banner),
    gate('MANUAL_APPROVAL', 'MANUAL APPROVAL', promo.live === 'GO' ? 'PASS' : 'FAIL', `promotion liveGoNoGo=${promo.live}. ${promo.failedGates.slice(0, 8).join(', ')}`),
    gate('ZERO_COST_RESEARCH', 'RESEARCH', isTheoreticalZeroCost() ? 'FAIL' : 'PASS', isTheoreticalZeroCost() ? 'Research costs are theoretical zero; cannot promote.' : 'Non-zero research costs configured.'),
    gate('QUANT_DEFAULT', 'STRATEGY', quantOn ? 'UNAVAILABLE' : 'PASS', quantOn ? 'QUANT_ENGINE_ENABLED=true does not imply VALIDATED.' : 'QUANT_ENGINE_ENABLED defaults off.'),
    gate('MIN_PAPER', 'PAPER', paperCountFloorsMet ? 'PASS' : 'FAIL', `Need >= ${researchSafety.minPaperTrades} organic trades and ${researchSafety.minPaperSessions} sessions. Observed ${paper.closedTradeCount}/${paper.sessionCount}.`),
    gate('PAPER_PROFIT_FACTOR', 'PAPER', paperProfitFactorPass ? 'PASS' : 'FAIL', `Organic profit factor ${paper.profitFactor ?? 'null'} vs min ${researchSafety.minPaperProfitFactor}. Null is FAIL.`),
    gate('PAPER_EXPECTANCY', 'PAPER', paperExpectancyPass ? 'PASS' : 'FAIL', `Organic expectancy ${paper.expectancy ?? 'null'} vs min ${researchSafety.minPaperExpectancy} (must be strictly greater). Null is FAIL.`),
    gate('PAPER_CALENDAR_DAYS', 'PAPER', paperCalendarDaysPass ? 'PASS' : 'FAIL', `Organic NY sessions ${paper.sessionCount} vs minPaperCalendarDays ${researchSafety.minPaperCalendarDays}.`),
    gate('OMS_HEALTH', 'OMS', 'UNAVAILABLE', 'OMS PENDING-first is implemented. Promotion omsHealthPass stays false until a paper soak with zero unknown orphans.'),
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
    engineeringCapableOfLiveExecution: eligibility.engineeringCapableOfLiveExecution,
    empiricallyJustifiedToRiskCapital: eligibility.empiricallyJustifiedToRiskCapital,
    liveEligibility: eligibility.liveEligibility,
    requirementMatrix,
    strategyBoard,
  };
}
