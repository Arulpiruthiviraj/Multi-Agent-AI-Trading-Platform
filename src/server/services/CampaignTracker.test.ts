import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EVENTS } from '../core/eventNames';
import { getTradingDateStr } from '../core/TradingCalendar';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';
import { resetSessionRecoveryForTests } from '../core/sessionRecovery';

describe('CampaignTracker + ideaGenerationGate BUY soft-lock', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let campaign: typeof import('./CampaignTracker');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_campaign_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    campaign = await import('./CampaignTracker');

    await db.insert(schema.settings).values({
      budget: 10000,
      campaignEnabled: true,
      dailyTargetAmount: 100,
      dailyTargetType: 'DOLLAR',
      targetAchievedAction: 'LOCK_AND_IDLE',
    });
  });

  afterAll(() => {
    // Clear in-memory BUY soft-lock so later files (same vitest process) are not gated.
    campaign?.resetCampaignTrackerStateForTests();
    resetSessionRecoveryForTests();
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    campaign.resetCampaignTrackerStateForTests();
    resetSessionRecoveryForTests();
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  it('resolveCampaignTargetDollars supports DOLLAR and PERCENT of budget', () => {
    expect(campaign.resolveCampaignTargetDollars(10000, 250, 'DOLLAR')).toBe(250);
    expect(campaign.resolveCampaignTargetDollars(10000, 2, 'PERCENT')).toBe(200);
    expect(campaign.resolveCampaignTargetDollars(0, 5, 'PERCENT')).toBe(0);
  });

  it('isCampaignBuyLocked is independent of Autobot until wired through ideaGenerationGate', () => {
    expect(campaign.isCampaignBuyLocked()).toBe(false);
    campaign.setCampaignBuyLockedForTests(true);
    expect(campaign.isCampaignBuyLocked()).toBe(true);
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
    campaign.setCampaignBuyLockedForTests(false);
    expect(isLiveIdeaGenerationEnabled()).toBe(true);
  });

  it('LOCK_AND_IDLE reaches target, emits CAMPAIGN_TARGET_REACHED, and soft-blocks BUY ideas only', async () => {
    const today = getTradingDateStr();
    const nowIso = new Date().toISOString();

    await db.insert(schema.trades).values({
      id: `camp-buy-${Date.now()}`,
      symbol: 'CAMP1',
      side: 'BUY',
      quantity: 10,
      price: 100,
      status: 'FILLED',
      timestamp: nowIso,
      filledAt: nowIso,
      quantStrategyId: 'MOMENTUM_BREAKOUT',
      executionEnvironment: 'PAPER',
    });
    await db.insert(schema.trades).values({
      id: `camp-sell-${Date.now()}`,
      symbol: 'CAMP1',
      side: 'SELL',
      quantity: 10,
      price: 112,
      status: 'FILLED',
      timestamp: nowIso,
      filledAt: nowIso,
      profitLoss: 120,
      executionEnvironment: 'PAPER',
    });

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const status = await campaign.refreshCampaignProgress('test');

    expect(status.progress).toBeGreaterThanOrEqual(1);
    expect(status.buyLocked).toBe(true);
    expect(status.badge).toBe('TARGET LOCKED');
    expect(campaign.isCampaignBuyLocked()).toBe(true);
    expect(isLiveIdeaGenerationEnabled()).toBe(false);

    const reached = emitSpy.mock.calls.find((c: any) => c[0] === EVENTS.CAMPAIGN_TARGET_REACHED);
    expect(reached).toBeTruthy();
    expect((reached as any)[1].action).toBe('LOCK_AND_IDLE');

    const rows = await db.select().from(schema.dailyStrategyPerformance).where(
      (await import('drizzle-orm')).eq(schema.dailyStrategyPerformance.tradingDate, today),
    );
    expect(rows.length).toBeGreaterThan(0);
    const attributed = rows.find((r: any) => r.quantStrategyId === 'MOMENTUM_BREAKOUT');
    expect(attributed).toBeTruthy();
    expect(attributed.realizedPnl).toBeGreaterThanOrEqual(120);

    emitSpy.mockRestore();
  });

  it('CONTINUE action tracks progress without BUY lock', async () => {
    await db.update(schema.settings).set({ targetAchievedAction: 'CONTINUE' });
    campaign.resetCampaignTrackerStateForTests();

    const status = await campaign.refreshCampaignProgress('continue_test');
    expect(status.progress).toBeGreaterThanOrEqual(1);
    expect(status.buyLocked).toBe(false);
    expect(isLiveIdeaGenerationEnabled()).toBe(true);

    await db.update(schema.settings).set({ targetAchievedAction: 'LOCK_AND_IDLE' });
  });

  it('TRAIL_STOPS_ONLY soft-blocks BUYs and badges CAPITAL PRESERVED without inventing trail math', async () => {
    await db.update(schema.settings).set({ targetAchievedAction: 'TRAIL_STOPS_ONLY' });
    campaign.resetCampaignTrackerStateForTests();

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const status = await campaign.refreshCampaignProgress('trail_test');

    expect(status.buyLocked).toBe(true);
    expect(status.badge).toBe('CAPITAL PRESERVED');
    const reached = emitSpy.mock.calls.find((c: any) => c[0] === EVENTS.CAMPAIGN_TARGET_REACHED);
    expect((reached as any)[1].action).toBe('TRAIL_STOPS_ONLY');
    expect((reached as any)[1].trailOwnedBy).toBe('PortfolioMonitor.trailingStopPct');

    emitSpy.mockRestore();
    await db.update(schema.settings).set({ targetAchievedAction: 'LOCK_AND_IDLE' });
  });

  it('deployedCapital/idleCapital/capitalUtilizationPct mirror RiskEngine\'s own argus_capital_allocation math (observability only)', async () => {
    // budget = 10000 (seeded in this describe block's beforeAll).
    await db.insert(schema.portfolio).values({
      symbol: 'CAPDEPLOY', quantity: 20, averagePrice: 50, lastUpdated: new Date().toISOString(),
    }); // 20 * 50 = $1000 deployed via positions

    await db.insert(schema.trades).values({
      id: `camp-pending-${Date.now()}`,
      symbol: 'CAPDEPLOY2',
      side: 'BUY',
      quantity: 5,
      price: 40,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
    }); // 5 * 40 = $200 reserved via a pending (non-terminal) BUY

    const status = await campaign.getCampaignStatus();

    expect(status.deployedCapital).toBeCloseTo(1200, 2); // 1000 positions + 200 pending BUY
    expect(status.idleCapital).toBeCloseTo(10000 - 1200, 2);
    expect(status.capitalUtilizationPct).toBeCloseTo((1200 / 10000) * 100, 2);
  });

  it('CampaignTracker never references placeOrder or RiskEngine', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/server/services/CampaignTracker.ts'), 'utf8');
    expect(src).not.toMatch(/\.placeOrder\(/);
    expect(src).not.toMatch(/RiskEngine/);
    expect(src).not.toMatch(/OrderManagement/);
    expect(src).not.toMatch(/setTradingState/);
  });
});
