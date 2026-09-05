import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compareExecutionModels, executionModelVersion, getExecutionModel } from './executionModel';
import {
  classifyTradeEnvironment,
  isOrganicClosedPaper,
  resolveOmsExecutionEnvironment,
  stampExecutionEnvironment,
  summarizeOrganicPaper,
} from './organicPaper';
import { deriveLifecycleStatus, emptyEvidence, liveGoNoGo, assertPromotionQuarantine } from './promotionEngine';
import { freezeStrategyVersion } from './strategySpecs';
import { findStrategy, resolveStrategiesForLiveEvaluation } from '../quant/strategies/StrategyEngine';
import { quantExperimentalStrategies } from '../config/quantExperimentalStrategies';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';
import { researchComparisonMatrix } from './strategyEvidence';
import { evaluatePitAiBuyGate } from '../engines/backtest/PitReplay';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { tradingSafety } from '../config/tradingSafety';
import { researchSafety } from '../config/researchSafety';

const ROOT = join(process.cwd());

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.venv' || name === 'archive') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

describe('Phase 21 evidence-path invariants', () => {
  it('canonical research fill is NEXT_BAR_OPEN and mixing SAME_BAR_CLOSE is ENGINE_MISMATCH', () => {
    expect(executionModelVersion()).toBe('argus-research-execution-v1');
    expect(getExecutionModel().executionModel).toBe('NEXT_BAR_OPEN');
    const cmp = compareExecutionModels('NEXT_BAR_OPEN', 'SAME_BAR_CLOSE');
    expect(cmp.status).toBe('ENGINE_MISMATCH');
    expect(cmp.compatible).toBe(false);
    expect(researchComparisonMatrix().engineCompare.status).toBe('ENGINE_MISMATCH');
  });

  it('SAME_BAR_CLOSE cannot leave UNTESTED even with all research flags set', () => {
    const e = {
      ...emptyEvidence('MOMENTUM_BREAKOUT', '1.0.0'),
      dataProvenance: 'REAL_MARKET_DATA' as const,
      executionModel: 'SAME_BAR_CLOSE',
      qualityStatus: 'GREEN' as const,
      parquetBytesWritten: true,
      dataQualityPass: true,
      backtestPass: true,
      oosPass: true,
      walkForwardPass: true,
      monteCarloPass: true,
      permutationPass: true,
      sensitivityPass: true,
      costStressPass: true,
      paperTrades: 999,
      paperSessions: 999,
      paperExpectancyPositive: true,
      paperDrawdownWithinLimit: true,
      riskGatePass: true,
      brokerHealthPass: true,
      marketDataHealthPass: true,
      startupHealthPass: true,
      organicPaperOnly: true,
      manualLiveApproval: true,
    };
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
    expect(liveGoNoGo(e).failedGates).toContain('EXECUTION_MODEL_NOT_CANONICAL');
  });

  it('empty evidence cannot become LIVE_APPROVED or enable LIVE', () => {
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
    expect(liveGoNoGo(e).failedGates).toContain('MANUAL_APPROVAL');
  });

  it('LIVE_CANDIDATE without manual approval is still LIVE NO-GO', () => {
    const e = {
      ...emptyEvidence('MOMENTUM_BREAKOUT', '1.0.0'),
      dataProvenance: 'REAL_MARKET_DATA' as const,
      executionModel: 'NEXT_BAR_OPEN',
      qualityStatus: 'GREEN' as const,
      parquetBytesWritten: true,
      dataQualityPass: true,
      backtestPass: true,
      oosPass: true,
      walkForwardPass: true,
      monteCarloPass: true,
      permutationPass: true,
      sensitivityPass: true,
      costStressPass: true,
      paperTrades: 999,
      paperSessions: 999,
      paperExpectancyPositive: true,
      paperDrawdownWithinLimit: true,
      paperProfitFactorPass: true,
      paperCalendarDaysPass: true,
      riskGatePass: true,
      brokerHealthPass: true,
      marketDataHealthPass: true,
      startupHealthPass: true,
      omsHealthPass: true,
      reconciliationHealthPass: true,
      restartRecoveryPass: true,
      failureRecoveryPass: true,
      observabilityPass: true,
      securityPass: true,
      organicPaperOnly: true,
      manualLiveApproval: false,
    };
    expect(deriveLifecycleStatus(e)).toBe('LIVE_CANDIDATE');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
  });

  it('promotion quarantine rejects SAME_BAR_CLOSE, non-GREEN, or missing parquet', () => {
    expect(assertPromotionQuarantine({
      executionModel: 'SAME_BAR_CLOSE',
      qualityStatus: 'GREEN',
      parquetBytesWritten: true,
    }).ok).toBe(false);
    expect(assertPromotionQuarantine({
      executionModel: 'NEXT_BAR_OPEN',
      qualityStatus: 'YELLOW',
      parquetBytesWritten: true,
    }).reasons).toContain('QUALITY_STATUS_NOT_GREEN');
    expect(assertPromotionQuarantine({
      executionModel: 'NEXT_BAR_OPEN',
      qualityStatus: 'GREEN',
      parquetBytesWritten: false,
    }).reasons).toContain('PARQUET_BYTES_NOT_WRITTEN');
    expect(assertPromotionQuarantine({
      executionModel: 'NEXT_BAR_OPEN',
      qualityStatus: 'GREEN',
      parquetBytesWritten: true,
    }).ok).toBe(true);
  });

  it('untagged fills are UNKNOWN and do not count as organic paper', () => {
    expect(classifyTradeEnvironment({ reasoning: 'ChiefTrader approved' })).toBe('UNKNOWN');
    expect(isOrganicClosedPaper({ status: 'FILLED', side: 'SELL', profitLoss: 12, reasoning: 'ChiefTrader approved' })).toBe(false);
    expect(isOrganicClosedPaper({
      status: 'FILLED',
      side: 'SELL',
      profitLoss: 12,
      reasoning: stampExecutionEnvironment('ChiefTrader approved', 'PAPER'),
    })).toBe(true);
    expect(isOrganicClosedPaper({
      status: 'FILLED',
      side: 'SELL',
      profitLoss: 99,
      traceId: 'manual-override-abc',
      reasoning: stampExecutionEnvironment('SOURCE: MANUAL_OVERRIDE — human', 'PAPER'),
    })).toBe(false);
    expect(classifyTradeEnvironment({
      traceId: 'manual-override-abc',
      reasoning: stampExecutionEnvironment('SOURCE: MANUAL_OVERRIDE — human', 'PAPER'),
    })).toBe('UNKNOWN');
    expect(isOrganicClosedPaper({
      status: 'FILLED',
      side: 'SELL',
      profitLoss: 12,
      traceId: 'diag-a-1786368993694',
      reasoning: stampExecutionEnvironment('Approved', 'PAPER'),
    })).toBe(false);
    const empty = summarizeOrganicPaper([], 30);
    expect(empty.closedTradeCount).toBe(0);
    expect(empty.sessionCount).toBe(0);
    expect(empty.sharpe.status).toBe('INSUFFICIENT_SAMPLE');
    expect(empty.invented).toBe(false);
  });

  it('organic paper sessions are NY calendar days of closed FILLED SELL rows, not invented', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      status: 'FILLED' as const,
      side: 'SELL' as const,
      profitLoss: 1,
      reasoning: stampExecutionEnvironment('OMS fill', 'PAPER'),
      timestamp: `2026-01-${String(i + 5).padStart(2, '0')}T20:00:00.000Z`,
    }));
    const s = summarizeOrganicPaper(rows, 30);
    expect(s.closedTradeCount).toBe(10);
    expect(s.sessionCount).toBe(10);
    expect(researchSafety.minPaperSessions).toBe(10);
  });

  it('OMS environment stamp does not invent PAPER for unknown brokers', () => {
    expect(resolveOmsExecutionEnvironment({ brokerId: 'internal_paper', tradingMode: 'Paper' })).toBe('PAPER');
    expect(resolveOmsExecutionEnvironment({ brokerId: 'lifecycle-stub', tradingMode: 'Paper' })).toBe('UNKNOWN');
    expect(resolveOmsExecutionEnvironment({ brokerId: 'internal_paper', tradingMode: 'LIVE' })).toBe('UNKNOWN');
    expect(resolveOmsExecutionEnvironment({ brokerId: 'lifecycle-stub', tradingMode: 'LIVE' })).toBe('UNKNOWN');
  });

  it('strategy version freeze is config-hashed and does not invent VALIDATED', () => {
    const v = freezeStrategyVersion('MOMENTUM_BREAKOUT');
    expect(v?.strategyVersion).toMatch(/^MOMENTUM_BREAKOUT-1\.0\.0-/);
    expect(v?.executionModel).toBe('NEXT_BAR_OPEN');
    expect(v?.configHash.startsWith('sha256:')).toBe(true);
  });

  it('experimental strategies stay out of live evaluateAll unless their env flag is true', () => {
    const experimentalVars = quantExperimentalStrategies.strategies.map((s) => s.enabledEnvVar);
    const prev = Object.fromEntries(experimentalVars.map((k) => [k, process.env[k]]));
    for (const k of experimentalVars) delete process.env[k];
    try {
      expect(findStrategy('SMC_LIQUIDITY_SWEEP')?.id).toBe('SMC_LIQUIDITY_SWEEP');
      const liveIds = resolveStrategiesForLiveEvaluation().map((s) => s.id);
      expect(liveIds).not.toContain('SMC_LIQUIDITY_SWEEP');
      expect(liveIds).toEqual(['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION']);
    } finally {
      for (const k of experimentalVars) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it('Autobot OFF disables live idea generation', () => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('empty PIT ledger cannot authorize AI BUY', () => {
    const gate = evaluatePitAiBuyGate([], 'AAPL', 100);
    expect(gate.allowBuy).toBe(false);
  });

  it('RiskEngine catalog still has 25 recorded gates (25th added 2026-09-05: extended_hours_execution_policy, Session-Aware Trading Architecture Phase 5)', () => {
    const catalog = loadRepoConfigJson<{ gates: string[] }>('riskGateOrder.json');
    expect(catalog.gates).toHaveLength(25);
  });

  it('never auto-flattens on reconciliation mismatch; consensus floors stay 0.75 / min 2', () => {
    expect(tradingSafety.autoFlattenOnReconciliationMismatch).toBe(false);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });

  it('restricted-live caps are ceilings, not profitability evidence', () => {
    expect(tradingSafety.restrictedLiveMaxOrderNotionalDollars).toBeGreaterThan(0);
    expect(tradingSafety.restrictedLiveMaxOpenPositions).toBeGreaterThan(0);
  });

  it('production TypeScript has no second OMS placeOrder path', () => {
    const files = walkFiles(join(ROOT, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!text.includes('.placeOrder(')) continue;
      const rel = relative(ROOT, f).replace(/\\/g, '/');
      const allowed =
        rel === 'src/server/services/OrderManagement.ts' ||
        rel.startsWith('src/brokers/');
      if (!allowed) hits.push(rel);
    }
    expect(hits).toEqual([]);
    expect(readFileSync(join(ROOT, 'server.ts'), 'utf8')).not.toMatch(/\.placeOrder\(/);
    const routeDir = join(ROOT, 'src', 'server', 'routes');
    const routeHits: string[] = [];
    for (const f of walkFiles(routeDir).filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))) {
      const text = readFileSync(f, 'utf8');
      if (text.includes('.closePosition(')) routeHits.push(relative(ROOT, f).replace(/\\/g, '/'));
    }
    expect(routeHits).toEqual([]);
    expect(readFileSync(join(ROOT, 'server.ts'), 'utf8')).not.toMatch(/\.closePosition\(/);
  });

  it('VectorBT/Python research CLI cannot place orders', () => {
    const cli = readFileSync(join(ROOT, 'python/argus_research/cli.py'), 'utf8');
    expect(cli).toContain('Never places broker orders');
    expect(cli).toContain('placeOrder');
    expect(cli).not.toMatch(/BrokerManager/);
    expect(cli).not.toMatch(/alpaca\.trade/);
  });

  it('UI does not call BrokerManager.placeOrder', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/BrokerManager\.getInstance/);
    expect(app).not.toMatch(/\.placeOrder\(/);
  });

  it('OMS persists executionEnvironment as a column, not only a reasoning stamp', () => {
    const schema = readFileSync(join(ROOT, 'src/server/db/schema.ts'), 'utf8');
    expect(schema).toMatch(/executionEnvironment: text\('execution_environment'\)/);
    const oms = readFileSync(join(ROOT, 'src/server/services/OrderManagement.ts'), 'utf8');
    expect(oms).toMatch(/executionEnvironment: this\.resolveFillEnvironment\(\)/);
  });

  it('OMS does not treat a placeOrder throw as a definitive REJECTED', () => {
    const oms = readFileSync(join(ROOT, 'src/server/services/OrderManagement.ts'), 'utf8');
    const idx = oms.indexOf('Broker execution failed');
    expect(idx).toBeGreaterThan(0);
    const catchBlock = oms.slice(idx, idx + 900);
    expect(catchBlock).toMatch(/submitOutcome=UNKNOWN/);
    expect(catchBlock).not.toMatch(/status = ["']REJECTED["']/);
  });

  it('OMS idempotency lookup failure aborts before the broker', () => {
    const oms = readFileSync(join(ROOT, 'src/server/services/OrderManagement.ts'), 'utf8');
    expect(oms).not.toMatch(/proceeding without it/);
    expect(oms).toMatch(/Idempotency check failed — aborting before broker/);
  });
});
