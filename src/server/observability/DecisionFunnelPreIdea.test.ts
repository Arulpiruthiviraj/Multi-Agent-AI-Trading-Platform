import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('reconstructPreIdeaStages (Phase 4A Decision Funnel)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-funnel-preidea-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('reconstructs DISCOVERED/RANKED/PROMOTED from a preceding scan shortlist entry (already_subscribed)', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { reconstructPreIdeaStages } = await import('./DecisionFunnelPreIdea');

    const ideaTs = 1_800_000_000_000;
    const scanTs = ideaTs - 5 * 60 * 1000; // 5 minutes before the idea

    await db.insert(eventTraces).values({
      id: 'evt-scan-1',
      correlationId: null,
      timestamp: scanTs,
      source: 'OpportunityDiscovery',
      eventType: 'OPPORTUNITY_SCAN_COMPLETED',
      payload: JSON.stringify({
        ran: true, scanned: 10, shortlisted: 10,
        shortlist: [
          { symbol: 'AAPL', assetClass: 'LARGE_CAP', reason: 'already_subscribed' },
          { symbol: 'MSFT', assetClass: 'LARGE_CAP', reason: 'watch_candidate' },
        ],
      }),
    });

    const stages = await reconstructPreIdeaStages('AAPL', ideaTs);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));

    expect(byStage.DISCOVERED.status).toBe('RECONSTRUCTED');
    expect(byStage.RANKED.status).toBe('RECONSTRUCTED');
    expect(byStage.PROMOTED.status).toBe('RECONSTRUCTED');
    expect(byStage.PROMOTED.detail).toMatch(/already an active subscription/i);
    expect(byStage.DATA_READY.status).toBe('RECONSTRUCTED');
  });

  it('reports PROMOTED as NOT_RECONSTRUCTIBLE when the shortlist reason is only watch_candidate', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { reconstructPreIdeaStages } = await import('./DecisionFunnelPreIdea');

    const ideaTs = 1_800_100_000_000;
    const scanTs = ideaTs - 2 * 60 * 1000;

    await db.insert(eventTraces).values({
      id: 'evt-scan-2',
      correlationId: null,
      timestamp: scanTs,
      source: 'OpportunityDiscovery',
      eventType: 'OPPORTUNITY_SCAN_COMPLETED',
      payload: JSON.stringify({ shortlist: [{ symbol: 'MSFT', assetClass: 'LARGE_CAP', reason: 'watch_candidate' }] }),
    });

    const stages = await reconstructPreIdeaStages('MSFT', ideaTs);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));

    expect(byStage.DISCOVERED.status).toBe('RECONSTRUCTED');
    expect(byStage.PROMOTED.status).toBe('NOT_RECONSTRUCTIBLE');
  });

  it('reports every pre-idea stage NOT_RECONSTRUCTIBLE (except DATA_READY) when no scan/subscribe event exists in the lookback window', async () => {
    vi.resetModules();
    const { reconstructPreIdeaStages } = await import('./DecisionFunnelPreIdea');

    const stages = await reconstructPreIdeaStages('ZZZZ', Date.now());
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));

    expect(byStage.DISCOVERED.status).toBe('NOT_RECONSTRUCTIBLE');
    expect(byStage.RANKED.status).toBe('NOT_RECONSTRUCTIBLE');
    expect(byStage.PROMOTED.status).toBe('NOT_RECONSTRUCTIBLE');
    expect(byStage.SUBSCRIBED.status).toBe('NOT_RECONSTRUCTIBLE');
    // DATA_READY is always reconstructed from the idea's own existence, never dependent on a lookback match.
    expect(byStage.DATA_READY.status).toBe('RECONSTRUCTED');
  });

  it('reconstructs SUBSCRIBED from a preceding WATCHLIST_SUBSCRIBE_REQUESTED event for the same symbol', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { reconstructPreIdeaStages } = await import('./DecisionFunnelPreIdea');

    const ideaTs = 1_800_200_000_000;
    const subTs = ideaTs - 10 * 60 * 1000;

    await db.insert(eventTraces).values({
      id: 'evt-sub-1',
      correlationId: null,
      timestamp: subTs,
      source: 'MarketUniverseScanner',
      eventType: 'WATCHLIST_SUBSCRIBE_REQUESTED',
      payload: JSON.stringify({ symbol: 'NVDA' }),
    });

    const stages = await reconstructPreIdeaStages('NVDA', ideaTs);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));
    expect(byStage.SUBSCRIBED.status).toBe('RECONSTRUCTED');
    expect(byStage.SUBSCRIBED.sourceEventType).toBe('WATCHLIST_SUBSCRIBE_REQUESTED');
  });

  it('does not match a scan/subscribe event for a different symbol', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { reconstructPreIdeaStages } = await import('./DecisionFunnelPreIdea');

    const ideaTs = 1_800_300_000_000;
    await db.insert(eventTraces).values({
      id: 'evt-sub-2',
      correlationId: null,
      timestamp: ideaTs - 60_000,
      source: 'MarketUniverseScanner',
      eventType: 'WATCHLIST_SUBSCRIBE_REQUESTED',
      payload: JSON.stringify({ symbol: 'TSLA' }),
    });

    const stages = await reconstructPreIdeaStages('GME', ideaTs);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));
    expect(byStage.SUBSCRIBED.status).toBe('NOT_RECONSTRUCTIBLE');
  });

  it('does not match a scan/subscribe event outside the 30-minute lookback window', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { reconstructPreIdeaStages } = await import('./DecisionFunnelPreIdea');

    const ideaTs = 1_800_400_000_000;
    await db.insert(eventTraces).values({
      id: 'evt-scan-3',
      correlationId: null,
      timestamp: ideaTs - 31 * 60 * 1000, // just outside the 30-minute window
      source: 'OpportunityDiscovery',
      eventType: 'OPPORTUNITY_SCAN_COMPLETED',
      payload: JSON.stringify({ shortlist: [{ symbol: 'AMD', assetClass: 'LARGE_CAP', reason: 'already_subscribed' }] }),
    });

    const stages = await reconstructPreIdeaStages('AMD', ideaTs);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));
    expect(byStage.DISCOVERED.status).toBe('NOT_RECONSTRUCTIBLE');
  });
});
