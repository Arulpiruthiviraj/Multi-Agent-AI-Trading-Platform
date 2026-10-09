/** Reviewed bridge from existing research evidence into the existing runtime lifecycle writer. */
import { createHash } from 'node:crypto';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '../db';
import { trades } from '../db/schema';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { researchSafety } from '../config/researchSafety';
import { findStrategy } from '../quant/strategies/StrategyEngine';
import { getStrategyLifecycleHistory, recordStrategyLifecycleTransition } from '../quant/strategies/StrategyEmissionEligibility';
import { strategyEvidenceDetail } from './strategyEvidence';
import { summarizeOrganicPaper, isOrganicClosedPaper } from './organicPaper';

export const quantCertificationConfig = loadRepoConfigJson<{ enabled: boolean; maxPaperEvidenceRows: number; maxReviewReasonChars: number }>('quantCertification.json');
if (typeof quantCertificationConfig.enabled !== 'boolean' || !Number.isSafeInteger(quantCertificationConfig.maxPaperEvidenceRows)
  || quantCertificationConfig.maxPaperEvidenceRows <= 0 || !Number.isSafeInteger(quantCertificationConfig.maxReviewReasonChars)
  || quantCertificationConfig.maxReviewReasonChars <= 0) throw new Error('Invalid quant certification configuration');

export interface CertificationSafety { paperOnly: boolean; mode: string; state: string; autobot: boolean }

export async function reviewQuantCertification(strategyId: string) {
  if (!findStrategy(strategyId)) throw new Error('UNKNOWN_STRATEGY_ID');
  const detail = strategyEvidenceDetail(strategyId);
  const history = await getStrategyLifecycleHistory(strategyId, { limit: 1 });
  const latest = history[0] ?? null;
  // Exact strategy attribution, not pooled performance across the whole portfolio.
  const rows = await db.select({ ...getTableColumns(trades), closingFillSupported: sql<number>`EXISTS(
    SELECT 1 FROM "fills" f WHERE f."order_id" = "trades"."id"
    AND f."quantity" > 0 AND f."price" > 0 AND f."realized_pnl" IS NOT NULL
  )` }).from(trades).where(eq(trades.quantStrategyId, strategyId))
    .limit(quantCertificationConfig.maxPaperEvidenceRows + 1);
  const organic = rows.filter(r => isOrganicClosedPaper(r));
  const supported = organic.filter(r => r.closingFillSupported === 1);
  const paper = summarizeOrganicPaper(supported, researchSafety.minPaperTrades);
  const reasons: string[] = [];
  if (latest && ['RETIRED', 'DEGRADED'].includes(latest.status)) reasons.push('QUARANTINED_REQUIRES_SEPARATE_RECERTIFICATION');
  if (latest && ['VALIDATED', 'CHAMPION'].includes(latest.status)) reasons.push('ALREADY_AUTHORIZED_LIFECYCLE');
  if (!detail.evaluated) reasons.push('NO_PERSISTED_RESEARCH_EVIDENCE');
  if (!['VALIDATED', 'LIVE_CANDIDATE', 'LIVE_APPROVED'].includes(detail.lifecycleStatus)) reasons.push('RESEARCH_GATES_INCOMPLETE');
  if (!detail.evidence.datasetId) reasons.push('NO_DATASET_ID');
  if (organic.length !== supported.length) reasons.push('ORGANIC_LEDGER_WITHOUT_CLOSING_FILL_ECONOMICS');
  if (rows.length > quantCertificationConfig.maxPaperEvidenceRows) reasons.push('PAPER_EVIDENCE_LIMIT_EXCEEDED');
  if (paper.closedTradeCount < researchSafety.minPaperTrades) reasons.push('INSUFFICIENT_STRATEGY_ORGANIC_PAPER_TRADES');
  if (paper.sessionCount < Math.max(researchSafety.minPaperSessions, researchSafety.minPaperCalendarDays)) reasons.push('INSUFFICIENT_STRATEGY_ORGANIC_PAPER_DAYS');
  if (paper.expectancy === null || !Number.isFinite(paper.expectancy) || paper.expectancy <= researchSafety.minPaperExpectancy) reasons.push('ORGANIC_PAPER_EXPECTANCY_NOT_POSITIVE');
  if (paper.profitFactor === null || !Number.isFinite(paper.profitFactor) || paper.profitFactor < researchSafety.minPaperProfitFactor) reasons.push('ORGANIC_PAPER_PROFIT_FACTOR_UNSUPPORTED');
  // Research cost/drawdown proofs are explicitly reviewed artifacts, not recomputed from gross fills here.
  const snapshot = { strategyId, previousId: latest?.id ?? null, detail, paper,
    paperTradeIds: supported.map(r => r.id).sort(), reasons,
    ledgerFingerprint: createHash('sha256').update(JSON.stringify(rows.map(r => ({ id: r.id, status: r.status,
      timestamp: r.timestamp, filledAt: r.filledAt, quantity: r.quantity, price: r.price,
      profitLoss: r.profitLoss, executionEnvironment: r.executionEnvironment, traceId: r.traceId,
      reasoning: r.reasoning, closingFillSupported: r.closingFillSupported })).sort((a, b) => a.id.localeCompare(b.id)))).digest('hex') };
  const reviewHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { ...snapshot, reviewHash, eligibleForReview: reasons.length === 0,
    target: 'VALIDATED' as const, live: 'NO-GO' as const,
    evidenceTrust: 'OPERATOR_REVIEW_OF_PERSISTED_RESEARCH_GATES_PLUS_STRATEGY_SCOPED_ORGANIC_LEDGER' as const };
}

export async function commitQuantCertification(strategyId: string, reviewHash: string, reviewer: string, reason: string,
  safety: () => CertificationSafety) {
  if (!quantCertificationConfig.enabled) throw new Error('CERTIFICATION_WORKFLOW_DISABLED');
  if (!reviewer.trim() || reviewer === 'unknown' || !reason.trim() || reason.length > quantCertificationConfig.maxReviewReasonChars) throw new Error('EXPLICIT_OPERATOR_REVIEW_REQUIRED');
  const assertSafety = () => {
    const s = safety();
    if (!s.paperOnly || s.mode !== 'PAPER' || s.state !== 'TRADING_PAUSED' || s.autobot) throw new Error('PAUSED_PAPER_WITH_AUTOBOT_OFF_REQUIRED');
  };
  assertSafety();
  const review = await reviewQuantCertification(strategyId);
  if (review.reviewHash !== reviewHash) throw new Error('EVIDENCE_REVIEW_STALE');
  if (!review.eligibleForReview) throw new Error(`CERTIFICATION_BLOCKED: ${review.reasons.join(',')}`);
  assertSafety();
  return recordStrategyLifecycleTransition(strategyId, 'VALIDATED', reason, {
    reviewer, reviewHash, evidenceTrust: review.evidenceTrust, research: review.detail,
    organicPaper: review.paper, paperTradeIds: review.paperTradeIds, live: 'NO-GO',
  }, review.paper.closedTradeCount, new Date(), review.previousId);
}
