import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB) for the AI Cost Governor observability report
 * (docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md §M). Read-only over real config +
 * real observability_events rows - never fabricates a ledger entry or a shadow decision.
 */
describe('aiCostGovernorReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./aiCostGovernorReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ai_cost_governor_report_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./aiCostGovernorReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('reports enabled/liveEnabled as false when no env flags are set (the safe default)', async () => {
    const report = await mod.buildAiCostGovernorReport();
    expect(report.enabled).toBe(false);
    expect(report.liveEnabled).toBe(false);
  });

  it('lists every configured policy, and an empty ledger for an agent with no graded outcomes yet', async () => {
    const report = await mod.buildAiCostGovernorReport();
    expect(report.policies.ReflectionEngine).toEqual({ tiers: ['LOCAL'], qualityFloor: 0 });
    expect(report.policies.FundamentalAgent.tiers).toEqual(['LOCAL', 'ECONOMICAL']);
    expect(report.ledger.FundamentalAgent).toEqual([]); // honest: no fabricated ledger row
  });

  it('surfaces a real shadow-mode decision event, never a fabricated one', async () => {
    await db.insert(schema.observabilityEvents).values({
      id: 'aicg-1', ts: Date.now(), level: 'INFO', category: 'AI', eventType: 'AI_COST_GOVERNOR_SHADOW_COMPARISON',
      loggerName: 'argus', message: 'ai_cost_governor_shadow_comparison', sessionId: 'test-session', traceId: 'trace-x',
      payload: JSON.stringify({ agentType: 'FundamentalAgent', policyTiers: ['LOCAL', 'ECONOMICAL'], chosenTier: 'LOCAL', changed: true, liveEnabled: false }),
    });
    const report = await mod.buildAiCostGovernorReport();
    const decision = report.recentShadowDecisions.find((d) => d.traceId === 'trace-x');
    expect(decision).toBeDefined();
    expect(decision!.agentType).toBe('FundamentalAgent');
    expect(decision!.chosenTier).toBe('LOCAL');
  });

  it('formatAiCostGovernorReport renders without crashing and never omits the master-flag state', async () => {
    const report = await mod.buildAiCostGovernorReport();
    const text = mod.formatAiCostGovernorReport(report);
    expect(text).toContain('AI COST GOVERNOR');
    expect(text).toContain('Master flag enabled: false');
  });
});
