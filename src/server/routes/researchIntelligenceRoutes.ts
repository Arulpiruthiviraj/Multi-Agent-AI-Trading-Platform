/**
 * ==========================================================
 * Module: researchIntelligenceRoutes
 *
 * Safe Research & Quant Intelligence Expansion (2026-08-25). Read-only research surface —
 * mirrors analyticsRoutes.ts's plain try/catch Router pattern. Every response is a
 * ResearchResult (canPlaceOrders:false, isLiveTrade:false, labeled RESEARCH/ADVISORY) — nothing
 * here can reach ChiefTrader, RiskEngine, OMS, or a broker (enforced by
 * researchIntelligenceBoundary.test.ts). Backtest/walk-forward/optimization/Monte Carlo, which
 * need a caller-prepared dataset or evaluator, stay programmatic-API-only in this pass — not
 * wired to a route yet, documented as a follow-up in the final audit rather than rushed.
 *
 * Real defect fixed (2026-08-26 comprehensive remediation pass): closesFor()'s
 * historicalDataGateway.ensureBars()/getBars() calls had no timeout of their own - the same
 * ERR_HTTP_HEADERS_SENT root cause already fixed twice in v2System.ts this session (an unbounded
 * call can run past server.ts's global 15s per-request backstop, which sends its own response
 * first; the handler's late resolution then tries to send a second one). Bound to 5s and every
 * response site in this file guarded with res.headersSent, matching that reviewed pattern.
 * ==========================================================
 */
import { Router } from 'express';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { withTimeout } from '../services/brokerPortfolioResponse';
import {
  runRegimeDetectionResearch,
  runMultiFactorResearch,
  runTradeSetupResearch,
  runCorrelationResearch,
  runDrawdownResearch,
  runMacroStrategyResearch,
  runStrategyGenerationResearch,
  runRiskRewardResearch,
} from '../research/intelligence';

export const researchIntelligenceRouter = Router();

const DEFAULT_LOOKBACK_DAYS = 180;

async function closesFor(symbol: string, days: number = DEFAULT_LOOKBACK_DAYS) {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  await withTimeout(historicalDataGateway.ensureBars(symbol, '1Day', startMs, endMs), 5000, `ensureBars ${symbol} (research-intelligence)`);
  return withTimeout(historicalDataGateway.getBars(symbol, '1Day', startMs, endMs), 5000, `getBars ${symbol} (research-intelligence)`);
}

researchIntelligenceRouter.get('/audit', (_req, res) => {
  res.json({
    label: 'RESEARCH',
    capabilities: [
      { name: 'Strategy Generation', status: 'RESEARCH', route: 'POST /strategy-generation' },
      { name: 'Backtesting', status: 'RESEARCH', route: 'programmatic API only — BacktestResearch.ts' },
      { name: 'Risk-Reward Analysis', status: 'RESEARCH', route: 'POST /risk-reward' },
      { name: 'Market Regime Detection', status: 'ADVISORY', route: 'POST /regime' },
      { name: 'Multi-Factor Strategy', status: 'RESEARCH', route: 'POST /multi-factor' },
      { name: 'Strategy Optimization', status: 'RESEARCH', route: 'programmatic API only — StrategyOptimizationResearch.ts' },
      { name: 'Correlation & Diversification', status: 'RESEARCH', route: 'POST /correlation' },
      { name: 'Trade Setup Generation', status: 'ADVISORY', route: 'POST /trade-setup' },
      { name: 'Monte Carlo Simulation', status: 'RESEARCH', route: 'programmatic API only — MonteCarloResearch.ts' },
      { name: 'Drawdown Analysis', status: 'RESEARCH', route: 'POST /drawdown' },
      { name: 'Macro-Based Strategy', status: 'ADVISORY', route: 'GET /macro' },
      { name: 'Alpha / Edge Detection', status: 'RESEARCH', route: 'programmatic API only — AlphaEdgeResearch.ts' },
    ],
    note: 'Research activity is never counted as live/organic trading activity — see session-report/trading-audit for that.',
  });
});

researchIntelligenceRouter.post('/regime', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const bars = await closesFor(symbol);
    if (!res.headersSent) res.json(runRegimeDetectionResearch({ symbol, bars }));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.post('/multi-factor', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const bars = await closesFor(symbol);
    if (!res.headersSent) res.json(runMultiFactorResearch({ symbol, bars }));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.post('/trade-setup', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const bars = await closesFor(symbol);
    if (!res.headersSent) res.json(runTradeSetupResearch({ symbol, bars }));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.post('/drawdown', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const bars = await closesFor(symbol);
    const equitySeries = bars.map((b) => ({ timestamp: b.timestamp, equity: b.close }));
    if (!res.headersSent) res.json(runDrawdownResearch({ symbol, source: `real ${symbol} close price series (not a P&L equity curve)`, equitySeries }));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.post('/correlation', async (req, res) => {
  try {
    const symbols: string[] = Array.isArray(req.body?.symbols) ? req.body.symbols.map((s: string) => s.toUpperCase()) : [];
    if (symbols.length < 2) return res.status(400).json({ error: 'symbols must be an array of at least 2 tickers' });
    const closesBySymbol: Record<string, number[]> = {};
    for (const symbol of symbols) {
      const bars = await closesFor(symbol);
      closesBySymbol[symbol] = bars.map((b) => b.close);
    }
    if (!res.headersSent) res.json(runCorrelationResearch({ closesBySymbol }));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.post('/risk-reward', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    const { entry, stop, target, strategyId } = req.body || {};
    if (!symbol || typeof entry !== 'number' || typeof stop !== 'number' || typeof target !== 'number') {
      return res.status(400).json({ error: 'symbol, entry, stop, target are required' });
    }
    const result = await withTimeout(runRiskRewardResearch({ symbol, entry, stop, target, strategyId }), 5000, 'runRiskRewardResearch');
    if (!res.headersSent) res.json(result);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.get('/macro', async (_req, res) => {
  try {
    const result = await withTimeout(runMacroStrategyResearch({}), 5000, 'runMacroStrategyResearch');
    if (!res.headersSent) res.json(result);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});

researchIntelligenceRouter.post('/strategy-generation', (req, res) => {
  try {
    const universe: string[] = Array.isArray(req.body?.universe) ? req.body.universe : [];
    const timeframe = String(req.body?.timeframe || '1Day');
    const targetRegime = req.body?.targetRegime;
    const riskProfile = req.body?.riskProfile;
    res.json(runStrategyGenerationResearch({ universe, timeframe, targetRegime, riskProfile }));
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e?.message || String(e) });
  }
});
