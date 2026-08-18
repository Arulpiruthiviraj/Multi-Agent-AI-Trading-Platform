import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  runOpportunityScan,
  getLastOpportunityScan,
  evaluateOpportunityCandidate,
  resetOpportunityScanForTests,
  setOpportunityScanInFlightForTests,
} from './OpportunityDiscovery';
import { canEmitPortfolioExitIdea, recordPortfolioDecision, resetPortfolioIntelForTests } from './portfolioIntel';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';

const FLAG_O = continuousIntelligence.opportunityLoopEnabledEnvVar;
const FLAG_P = continuousIntelligence.portfolioIntelEnabledEnvVar;

afterEach(() => {
  delete process.env[FLAG_O];
  delete process.env[FLAG_P];
  delete process.env.ARGUS_MULTI_ASSET_ENABLED;
  delete process.env.ARGUS_PENNY_STOCK_ENABLED;
  resetPortfolioIntelForTests();
  resetOpportunityScanForTests();
  setOpportunityScanInFlightForTests(false);
});

describe('opportunity loop', () => {
  it('is idle and emits zero trade ideas when the flag is off', async () => {
    delete process.env[FLAG_O];
    const ideas: unknown[] = [];
    const onIdea = (p: unknown) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    const stats = await runOpportunityScan();
    eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    expect(stats.enabled).toBe(false);
    expect(stats.ideasEmitted).toBe(0);
    expect(ideas).toHaveLength(0);
    expect(getLastOpportunityScan().ideasEmitted).toBe(0);
  });

  it('when enabled, requests a bounded subscribe set and still emits zero trade ideas', async () => {
    process.env[FLAG_O] = 'true';
    const ideas: unknown[] = [];
    const onIdea = (p: unknown) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    const stats = await runOpportunityScan();
    eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    expect(stats.enabled).toBe(true);
    expect(stats.ran).toBe(true);
    expect(stats.ideasEmitted).toBe(0);
    expect(stats.subscribeRequested).toBeLessThanOrEqual(continuousIntelligence.maxNewSubscriptionsPerCycle);
    expect(ideas).toHaveLength(0);
    expect(stats.scanned).toBe(continuousIntelligence.seedSymbols.length);
    expect(stats.shortlisted).toBeGreaterThan(0);
    for (const row of stats.shortlist) {
      expect(looksLikeListedTicker(row.symbol)).toBe(row.symbol);
    }
  });

  it('skips overlapping scans', async () => {
    process.env[FLAG_O] = 'true';
    setOpportunityScanInFlightForTests(true);
    const second = await runOpportunityScan();
    expect(second.skippedOverlap).toBe(true);
    expect(second.ideasEmitted).toBe(0);
  });

  it('rejects garbage tickers without ranking them', () => {
    expect(evaluateOpportunityCandidate('NOT A TICKER').action).toBe('reject');
    expect(evaluateOpportunityCandidate('!!!!!!').reason).toBe('INVALID_SYMBOL');
  });

  it('blocks penny names on unknown spread and poor liquidity when penny overlay is on', () => {
    process.env.ARGUS_MULTI_ASSET_ENABLED = 'true';
    process.env.ARGUS_PENNY_STOCK_ENABLED = 'true';
    const spreadUnknown = evaluateOpportunityCandidate('ABCD', { price: 1.25 });
    expect(spreadUnknown.action).toBe('reject');
    expect(spreadUnknown.reason).toBe('ASSET_SPREAD_UNKNOWN');
    const wideSpread = evaluateOpportunityCandidate('ABCE', {
      price: 1.25,
      bid: 1.0,
      ask: 1.5,
      averageDollarVolume: 1_000_000,
    });
    expect(wideSpread.action).toBe('reject');
    expect(wideSpread.reason).toMatch(/SPREAD/);
    const illiquid = evaluateOpportunityCandidate('ABCF', {
      price: 1.25,
      bid: 1.24,
      ask: 1.25,
      averageDollarVolume: 100,
    });
    expect(illiquid.action).toBe('reject');
    expect(illiquid.reason).toBe('POOR_LIQUIDITY');
  });

  it('does not treat DATA_UNAVAILABLE as a BUY and does not call AI/news/fundamentals', () => {
    const discovery = readFileSync(join(process.cwd(), 'src', 'server', 'continuous', 'OpportunityDiscovery.ts'), 'utf8');
    expect(discovery).not.toMatch(/emitTradeIdea/);
    expect(discovery).not.toMatch(/EVENTS\.TRADE_IDEA_GENERATED/);
    expect(discovery).not.toMatch(/AIRouter/);
    expect(discovery).not.toMatch(/AlphaVantage/);
    expect(discovery).not.toMatch(/NewsEngine/);
    expect(discovery).not.toMatch(/FundamentalAgent/);
    expect(discovery).not.toMatch(/MacroAgent/);
  });
});

describe('portfolio intel cooldown', () => {
  it('does not suppress exits when the overlay is off', () => {
    delete process.env[FLAG_P];
    expect(canEmitPortfolioExitIdea('AAPL')).toBe(true);
    expect(canEmitPortfolioExitIdea('AAPL')).toBe(true);
  });

  it('dedupes exit ideas for the same symbol when enabled', () => {
    process.env[FLAG_P] = 'true';
    expect(canEmitPortfolioExitIdea('NVDA', 1_000_000)).toBe(true);
    expect(canEmitPortfolioExitIdea('NVDA', 1_000_001)).toBe(false);
    expect(canEmitPortfolioExitIdea('AAPL', 1_000_001)).toBe(true);
  });

  it('HOLD telemetry is not an order', () => {
    process.env[FLAG_P] = 'true';
    const recorded: unknown[] = [];
    const onRec = (p: unknown) => recorded.push(p);
    eventBus.subscribe(EVENTS.PORTFOLIO_DECISION_RECORDED, onRec);
    recordPortfolioDecision({ symbol: 'NVDA', state: 'HEALTHY', reason: 'HOLD this cycle', pnlPct: 1.2 });
    eventBus.unsubscribe(EVENTS.PORTFOLIO_DECISION_RECORDED, onRec);
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { state: string }).state).toBe('HEALTHY');
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('adversarial isolation', () => {
  it('continuous modules never call placeOrder / OMS / BrokerManager', () => {
    const dir = join(process.cwd(), 'src', 'server', 'continuous');
    const forbidden = ['placeOrder(', 'BrokerManager', 'OrderManagement', 'executeOrder'];
    for (const file of walkTs(dir)) {
      const realHits: string[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        for (const token of forbidden) {
          if (line.includes(token)) realHits.push(`${file}: ${trimmed}`);
        }
      }
      expect(realHits).toEqual([]);
    }
    const routes = readFileSync(join(process.cwd(), 'src', 'server', 'routes', 'continuousIntelRoutes.ts'), 'utf8');
    expect(routes).not.toMatch(/placeOrder\(/);
    expect(routes).not.toMatch(/BrokerManager/);
  });

  it('ChiefTrader consensus thresholds were not lowered in this overlay', () => {
    const chief = readFileSync(join(process.cwd(), 'src', 'server', 'services', 'ChiefTraderAgent.ts'), 'utf8');
    expect(chief).toMatch(/CONSENSUS_APPROVAL_THRESHOLD/);
    const safety = readFileSync(join(process.cwd(), 'config', 'tradingSafety.json'), 'utf8');
    expect(safety).toMatch(/"consensusApprovalThreshold":\s*0\.75/);
    expect(safety).toMatch(/"minIndependentAgreeingAgents":\s*2/);
  });
});
