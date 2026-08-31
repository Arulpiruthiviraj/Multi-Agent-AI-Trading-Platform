import { Router } from 'express';
import {
  continuousIntelligence,
  isOpportunityIdeasEnabled,
  isOpportunityLoopEnabled,
  isPortfolioIntelEnabled,
} from '../config/continuousIntelligence';
import { getLastOpportunityScan } from '../continuous/OpportunityDiscovery';
import { listCandidates } from '../continuous/candidateLifecycle';
import { getLastSnapshotScanStats } from '../continuous/SnapshotScanner';
import { getCachedBroadUniverseSymbols, getLastBroadUniverseStats } from '../continuous/MarketUniverseScanner';
import { isBroadUniverseEnabled } from '../config/continuousIntelligence';
import { getPipelineRateSnapshot } from '../core/pipelineRateLimit';
import { marketDataWorker } from '../services/MarketDataWorker';
import { learningRouter } from './learningRoutes';

export const continuousIntelRouter = Router();

// Phase 4G/4H (Learning + Champion/Challenger, 2026-08-27) - see learningRoutes.ts.
continuousIntelRouter.use('/learning', learningRouter);

// ==========================================================================================
// Phase 4C (Composable Candidate Ranking, 2026-08-26) - real, persisted per-symbol ranking
// history from candidate_rankings, so "why did this rank #3 while another ranked #89" is always
// answerable from a specific row, not just the single latest in-memory cycle. Discovery only -
// never imports OMS/RiskEngine/the order-placement broker layer.
// ==========================================================================================
continuousIntelRouter.get('/ranking/latest', async (req, res) => {
  try {
    const { db } = await import('../db');
    const { candidateRankings } = await import('../db/schema');
    const { desc } = await import('drizzle-orm');
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

    const latestCycleRow = await db.select({ cycleAt: candidateRankings.cycleAt })
      .from(candidateRankings).orderBy(desc(candidateRankings.cycleAt)).limit(1).get();
    if (!latestCycleRow) {
      return res.json({ ok: true, cycleAt: null, count: 0, candidates: [] });
    }
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(candidateRankings)
      .where(eq(candidateRankings.cycleAt, latestCycleRow.cycleAt))
      .orderBy(candidateRankings.rank)
      .limit(limit);
    res.json({
      ok: true,
      cycleAt: latestCycleRow.cycleAt,
      count: rows.length,
      candidates: rows.map((r) => ({
        symbol: r.symbol,
        rank: r.rank,
        previousRank: r.previousRank,
        rankDelta: r.rankDelta,
        finalScore: r.finalScore,
        components: {
          momentum: r.momentumScore,
          relativeVolume: r.relativeVolumeScore,
          rangeExpansion: r.rangeExpansionScore,
          gap: r.gapScore,
          liquidity: r.liquidityScore,
          newsCatalyst: r.newsCatalystScore,
          agentConfidence: r.agentConfidenceScore,
        },
        componentAvailability: JSON.parse(r.componentAvailability || '{}'),
        promotionRecommendation: r.promotionRecommendation,
        promotionReason: r.promotionReason,
      })),
    });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

continuousIntelRouter.get('/ranking/history/:symbol', async (req, res) => {
  try {
    const { db } = await import('../db');
    const { candidateRankings } = await import('../db/schema');
    const { desc, eq } = await import('drizzle-orm');
    const symbol = req.params.symbol.toUpperCase();
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const rows = await db.select().from(candidateRankings)
      .where(eq(candidateRankings.symbol, symbol))
      .orderBy(desc(candidateRankings.cycleAt))
      .limit(limit);
    res.json({
      ok: true,
      symbol,
      count: rows.length,
      history: rows.map((r) => ({
        cycleAt: r.cycleAt,
        rank: r.rank,
        previousRank: r.previousRank,
        rankDelta: r.rankDelta,
        finalScore: r.finalScore,
        componentAvailability: JSON.parse(r.componentAvailability || '{}'),
        promotionRecommendation: r.promotionRecommendation,
        promotionReason: r.promotionReason,
      })),
    });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 4D (Dynamic Subscription Priority Queue, 2026-08-26) - real, persisted promotion/
// eviction decisions (MarketDataWorker.pruneLeastActiveWatchSymbols /
// OpportunityDiscovery.explainSnapshotHotSwapDecisions), so "why was X promoted / not promoted /
// evicted" is answerable without reading server console output. Discovery only.
// ==========================================================================================
continuousIntelRouter.get('/subscription-decisions', async (req, res) => {
  try {
    const { db } = await import('../db');
    const { observabilityEvents } = await import('../db/schema');
    const { like, desc } = await import('drizzle-orm');
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const rows = await db.select().from(observabilityEvents)
      .where(like(observabilityEvents.eventType, 'SUBSCRIPTION_%'))
      .orderBy(desc(observabilityEvents.ts))
      .limit(limit);
    res.json({
      ok: true,
      count: rows.length,
      decisions: rows.map((r) => ({
        ts: new Date(r.ts).toISOString(),
        symbol: r.symbol,
        action: (r.eventType || '').replace('SUBSCRIPTION_', ''),
        reason: r.message === 'subscription_priority_decision' ? JSON.parse(r.payload || '{}').reasoning ?? null : null,
      })),
    });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

continuousIntelRouter.get('/capacity', (_req, res) => {
  try {
    const activeSymbols = marketDataWorker.getActiveSymbols();
    const coreSymbols = marketDataWorker.getCoreSymbols();
    const cap = marketDataWorker.getEffectiveStreamingCap();
    res.json({
      ok: true,
      activeCount: activeSymbols.length,
      effectiveCap: cap,
      utilizationPct: cap > 0 ? activeSymbols.length / cap : 0,
      emptySlots: Math.max(0, cap - activeSymbols.length),
      coreCount: coreSymbols.length,
      dynamicCount: Math.max(0, activeSymbols.length - coreSymbols.length),
      activeSlots: marketDataWorker.getActiveSlots(),
    });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 4E (Pre-Market TradePlan, 2026-08-27) - real, persisted pre-market plans + revalidation
// history. A TradePlan is a hypothesis, never an order - this route is read-only. Discovery/
// preparation only, never imports OMS/RiskEngine/the order-placement broker layer.
// ==========================================================================================
continuousIntelRouter.get('/trade-plans/:planDate', async (req, res) => {
  try {
    const { getTradePlansForDate } = await import('./../continuous/TradePlanBuilder');
    const plans = await getTradePlansForDate(req.params.planDate);
    res.json({
      ok: true,
      planDate: req.params.planDate,
      count: plans.length,
      plans: plans.map((p) => ({
        ...p,
        catalysts: JSON.parse(p.catalysts || '[]'),
        componentScoresJson: undefined,
        components: JSON.parse(p.componentScoresJson || '{}'),
      })),
    });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

continuousIntelRouter.get('/trade-plans/:planDate/:planId/revalidations', async (req, res) => {
  try {
    const { getRevalidationHistory } = await import('./../continuous/TradePlanBuilder');
    const history = await getRevalidationHistory(req.params.planId);
    res.json({ ok: true, planId: req.params.planId, count: history.length, history });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

continuousIntelRouter.get('/missed-opportunities', async (req, res) => {
  try {
    const { getMissedOpportunities } = await import('./../continuous/MissedOpportunityDetector');
    const sinceMs = Number(req.query.sinceMs) || 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - sinceMs).toISOString();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = await getMissedOpportunities(since, limit);
    const byClassification: Record<string, number> = {};
    for (const r of rows) byClassification[r.classification] = (byClassification[r.classification] ?? 0) + 1;
    res.json({ ok: true, since, count: rows.length, byClassification, rows });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

continuousIntelRouter.get('/status', (_req, res) => {
  const snap = getLastSnapshotScanStats();
  res.json({
    ok: true,
    live: 'NO-GO',
    opportunityLoopEnabled: isOpportunityLoopEnabled(),
    opportunityIdeasEnabled: isOpportunityIdeasEnabled(),
    portfolioIntelEnabled: isPortfolioIntelEnabled(),
    honesty: continuousIntelligence.honesty,
    entryConsensusUnchanged: true,
    consensusNote: 'ChiefTrader min-agents and 0.75 bar are unchanged. Risk-exit SELL from PortfolioManager still skips entry quorum and still hits RiskEngine/OMS.',
    maxActiveSubscriptions: continuousIntelligence.maxActiveSubscriptions,
    activeSymbols: marketDataWorker.getActiveSymbols(),
    activeSlots: marketDataWorker.getActiveSlots(),
    lastScan: {
      scannedCount: snap.scanned,
      topMovers: snap.top.map((t) => t.symbol),
      // Phase 3C (Candidate Ranking dashboard): the full per-symbol score breakdown was already
      // computed by scoreSnapshotCandidate() and cached here — topMovers above discarded
      // everything but the symbol name. Discovery score only, never a trade signal or risk
      // approval (SnapshotScanner.ts never imports the order-placement/broker layer).
      top: snap.top,
      latencyMs: snap.latencyMs,
      lastHttpStatus: snap.lastHttpStatus,
      timestamp: snap.at,
      rth: snap.rth,
      error: snap.error,
    },
    lastOpportunityScan: getLastOpportunityScan(),
    candidates: listCandidates(),
    pipelineRate: getPipelineRateSnapshot(),
    ideasEmittedByScanner: 0,
    broadUniverse: {
      enabled: isBroadUniverseEnabled(),
      lastRefresh: getLastBroadUniverseStats(),
      cachedCandidateCount: getCachedBroadUniverseSymbols().length,
    },
  });
});
