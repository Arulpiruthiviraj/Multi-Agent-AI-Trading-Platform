import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { GlobalTradingStateSummary } from './whyNoTradeReport';

describe('whyNoTradeReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./whyNoTradeReport');
  let candidateLifecycle: typeof import('../continuous/candidateLifecycle');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_why_no_trade_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./whyNoTradeReport');
    candidateLifecycle = await import('../continuous/candidateLifecycle');
  });

  afterEach(() => {
    candidateLifecycle.resetCandidatesForTests();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  // Hermetic global-state stub: keeps report tests off the live runtime (TradingEngine,
  // ArgusRuntime, MarketDataWorker are never imported in tests).
  const stubGlobal = (overrides: Partial<GlobalTradingStateSummary> = {}) => ({
    readGlobalState: async (): Promise<GlobalTradingStateSummary> => ({
      ...mod.NULL_GLOBAL_TRADING_STATE,
      broker: { ...mod.NULL_GLOBAL_TRADING_STATE.broker },
      ...overrides,
    }),
  });

  function seedTerminalReasonEvent(overrides: Partial<{
    id: string; ts: number; symbol: string; traceId: string; approved: boolean; decisionTier: string;
    terminalReasonCode: string; rawConfidence: number; finalConfidence: number; independentAgentCount: number;
    participatingAgents: Array<{ agent: string; side: string; confidence: number }>;
  }>) {
    const symbol = overrides.symbol ?? 'NVDA';
    const traceId = overrides.traceId ?? 'trace-nvda-1';
    const payload = {
      symbol, traceId, approved: false, decisionTier: 'STRONG', terminalReasonCode: 'CONFIDENCE_BELOW_STRONG',
      rawConfidence: 0.5, finalConfidence: 0.5, independentAgentCount: 1,
      participatingAgents: [{ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.5 }],
      ...overrides,
    };
    return db.insert(schema.observabilityEvents).values({
      id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
      ts: overrides.ts ?? Date.now(),
      level: 'INFO', category: 'CONSENSUS', eventType: 'CONSENSUS_TERMINAL_REASON',
      loggerName: 'argus', message: 'consensus_terminal_reason', sessionId: 'sess-1',
      symbol, traceId,
      payload: JSON.stringify(payload),
    });
  }

  /** Seeds a real-shape quant_policy_evaluated structured-log row (what ChiefTraderAgent emits). */
  function seedQuantPolicyEvent(overrides: Partial<{
    id: string; ts: number; symbol: string; traceId: string; eventType: string; side: string;
    reasonCode: string; reason: string; strategyId: string; strategyLifecycle: string;
    authorization: string; authorizationReason: string; supportSatisfied: number; supportRequired: number;
    riskRewardRatio: number; strategyConfidence: number;
    checks: Array<{ id: string; category: string; passed: boolean; detail: string }>;
  }>) {
    const symbol = overrides.symbol ?? 'QNVDA';
    const traceId = overrides.traceId ?? 'trace-quant-1';
    const eventType = overrides.eventType ?? 'QUANT_POLICY_REJECTED';
    const payload = {
      category: 'CONSENSUS', eventType, traceId, symbol, side: 'BUY', decisionPolicy: 'QUANT_EXECUTION',
      ideaOrigin: 'QUANT_STRATEGY', strategyId: 'MOMENTUM_BREAKOUT', strategyLifecycle: 'CERTIFIED',
      authorization: 'PAPER_ONLY', authorizationReason: 'strategy certified for paper execution',
      reasonCode: 'SUPPORT_DIMENSIONS_INSUFFICIENT', reason: 'Only 2 of 3 support dimensions satisfied',
      supportSatisfied: 2, supportRequired: 3, riskRewardRatio: 1.8, strategyConfidence: 0.62,
      consensusConfidence: null, aiProvidersRoutable: 0, policyDurationMs: 12,
      checks: [
        { id: 'support_dimensions', category: 'SUPPORT', passed: false, detail: '2/3' },
        { id: 'risk_reward', category: 'ECONOMICS', passed: true, detail: '1.8 >= 1.5' },
      ],
      ...overrides,
    };
    return db.insert(schema.observabilityEvents).values({
      id: overrides.id ?? `qevt-${Math.random().toString(36).slice(2)}`,
      ts: overrides.ts ?? Date.now(),
      level: 'INFO', category: 'CONSENSUS', eventType,
      loggerName: 'argus', message: 'quant_policy_evaluated', sessionId: 'sess-1',
      symbol, traceId,
      payload: JSON.stringify(payload),
    });
  }

  /** Seeds a trade_lifecycle_transitions row whose evidence carries a DESK_NO_TRADE payload with
   * terminalReasonCode QUANT_NOT_AUTHORIZED (the only place that rejection is persisted). */
  function seedQuantNotAuthorizedLifecycle(overrides: Partial<{
    id: string; symbol: string; traceId: string; quantReasonCode: string; authorizationReason: string; strategyId: string; createdAt: string;
  }>) {
    const symbol = overrides.symbol ?? 'QNA';
    const traceId = overrides.traceId ?? 'trace-qna-1';
    const evidence = {
      type: 'DESK_NO_TRADE',
      payload: {
        traceId, symbol, side: 'BUY', confidence: 0.7,
        reason: `[Quant Not Eligible] strategy ${overrides.strategyId ?? 'MOMENTUM_BREAKOUT'}: ${overrides.quantReasonCode ?? 'STRATEGY_RETIRED'} (lifecycle RETIRED). No consensus attempted.`,
        decisionPolicy: 'QUANT_EXECUTION', decisionTier: 'QUANT_EXECUTION',
        quantReasonCode: overrides.quantReasonCode ?? 'STRATEGY_RETIRED',
        terminalReasonCode: 'QUANT_NOT_AUTHORIZED',
        strategyId: overrides.strategyId ?? 'MOMENTUM_BREAKOUT',
        authorizationReason: overrides.authorizationReason ?? 'strategy lifecycle is RETIRED',
      },
    };
    return db.insert(schema.tradeLifecycleTransitions).values({
      id: overrides.id ?? `lc-${Math.random().toString(36).slice(2)}`,
      candidateId: traceId, symbol, state: 'NO_TRADE',
      reason: evidence.payload.reason, source: 'ChiefTraderAgent',
      evidenceJson: JSON.stringify(evidence), latencyMs: 3,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
    });
  }

  it('reports found:false when no CONSENSUS_TERMINAL_REASON row exists for the symbol', async () => {
    const report = await mod.buildWhyNoTradeReport('GHOST', stubGlobal());
    expect(report.found).toBe(false);
    expect(report.symbol).toBe('GHOST');
    expect(report.risk.reached).toBe(false);
  });

  it('returns the most recent evaluation for a symbol with participating agents and terminal reason', async () => {
    await seedTerminalReasonEvent({
      ts: 1000, symbol: 'NVDA', traceId: 'trace-old', terminalReasonCode: 'INSUFFICIENT_AGENT_PARTICIPATION',
    });
    await seedTerminalReasonEvent({
      ts: 2000, symbol: 'NVDA', traceId: 'trace-new', terminalReasonCode: 'CONFIDENCE_BELOW_STRONG',
      rawConfidence: 0.51, independentAgentCount: 2,
      participatingAgents: [
        { agent: 'TechnicalAgent', side: 'BUY', confidence: 0.442 },
        { agent: 'QuantEngine', side: 'BUY', confidence: 0.604 },
      ],
    });

    const report = await mod.buildWhyNoTradeReport('NVDA', stubGlobal());
    expect(report.found).toBe(true);
    expect(report.traceId).toBe('trace-new');
    expect(report.terminalReasonCode).toBe('CONFIDENCE_BELOW_STRONG');
    expect(report.independentAgentCount).toBe(2);
    expect(report.participatingAgents).toHaveLength(2);
  });

  it('finds a real CONSENSUS_TERMINAL_REASON row even when 60 noisier same-symbol events (ticks/subscriptions) are more recent - regression for a bug where an in-memory top-50-by-ts window silently hid it', async () => {
    await seedTerminalReasonEvent({ ts: 1000, symbol: 'ZZZZ', traceId: 'trace-real', terminalReasonCode: 'AGENT_HOLD' });
    for (let i = 0; i < 60; i++) {
      await db.insert(schema.observabilityEvents).values({
        id: `noise-${i}`, ts: 2000 + i, level: 'INFO', category: 'DISCOVERY', eventType: 'SUBSCRIPTION_PROMOTED',
        loggerName: 'argus', message: 'subscription_priority_decision', sessionId: 'sess-1', symbol: 'ZZZZ',
        payload: null,
      });
    }
    const report = await mod.buildWhyNoTradeReport('ZZZZ', stubGlobal());
    expect(report.found).toBe(true);
    expect(report.traceId).toBe('trace-real');
  });

  it('joins real risk_assessments/risk_gate_results by traceId when consensus was approved', async () => {
    await seedTerminalReasonEvent({
      symbol: 'AAPL', traceId: 'trace-approved', approved: true, decisionTier: 'STRONG',
      terminalReasonCode: 'CONSENSUS_APPROVED', rawConfidence: 0.8, finalConfidence: 0.8, independentAgentCount: 2,
    });
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-approved', symbol: 'AAPL', side: 'BUY', approved: false,
      rejectionGate: 'symbol_concentration', maxQuantity: 0, createdAt: new Date().toISOString(),
    });
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace-approved', gateName: 'emergency_stop', sequence: 1, passed: true },
      { traceId: 'trace-approved', gateName: 'symbol_concentration', sequence: 2, passed: false, detail: '{"current":0.22,"max":0.20}' },
    ]);

    const report = await mod.buildWhyNoTradeReport('AAPL', stubGlobal());
    expect(report.approved).toBe(true);
    expect(report.risk.reached).toBe(true);
    expect(report.risk.approved).toBe(false);
    expect(report.risk.rejectionGate).toBe('symbol_concentration');
    expect(report.risk.gateResults).toHaveLength(2);
    expect(report.risk.gateResults[1]).toMatchObject({ gateName: 'symbol_concentration', passed: false });
  });

  it('includes the current candidateLifecycle state for the symbol when tracked', async () => {
    candidateLifecycle.upsertCandidate({ symbol: 'MSFT', state: 'WATCHING', now: Date.now() });
    await seedTerminalReasonEvent({ symbol: 'MSFT', traceId: 'trace-msft' });

    const report = await mod.buildWhyNoTradeReport('MSFT', stubGlobal());
    expect(report.candidateState).toBe('WATCHING');
  });

  it('computes nextEligibleReevaluationAt from same_symbol_cooldown detail (lastFillMs + cooldownMs) - real timestamp, never fabricated', async () => {
    await seedTerminalReasonEvent({
      symbol: 'COOL', traceId: 'trace-cooldown', approved: true, terminalReasonCode: 'CONSENSUS_APPROVED',
    });
    const lastFillMs = 1_700_000_000_000;
    const cooldownMs = 300000;
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-cooldown', symbol: 'COOL', side: 'BUY', approved: false,
      rejectionGate: 'same_symbol_cooldown', maxQuantity: 0, createdAt: new Date().toISOString(),
    });
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace-cooldown', gateName: 'emergency_stop', sequence: 1, passed: true },
      { traceId: 'trace-cooldown', gateName: 'same_symbol_cooldown', sequence: 2, passed: false, detail: JSON.stringify({ cooldownMs, lastFillMs, ageMs: 1000 }) },
    ]);

    const report = await mod.buildWhyNoTradeReport('COOL', stubGlobal());
    expect(report.nextEligibleReevaluationAt).toBe(new Date(lastFillMs + cooldownMs).toISOString());
    const text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('Next eligible reevaluation:');
  });

  it('leaves nextEligibleReevaluationAt null for a non-cooldown rejection gate (e.g. symbol_concentration) rather than guessing', async () => {
    await seedTerminalReasonEvent({
      symbol: 'NOGUESS', traceId: 'trace-noguess', approved: true, terminalReasonCode: 'CONSENSUS_APPROVED',
    });
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-noguess', symbol: 'NOGUESS', side: 'BUY', approved: false,
      rejectionGate: 'symbol_concentration', maxQuantity: 0, createdAt: new Date().toISOString(),
    });
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace-noguess', gateName: 'symbol_concentration', sequence: 1, passed: false, detail: '{"current":0.22,"max":0.20}' },
    ]);

    const report = await mod.buildWhyNoTradeReport('NOGUESS', stubGlobal());
    expect(report.nextEligibleReevaluationAt).toBeNull();
  });

  it('formatWhyNoTradeReport renders a readable CLI text block ending in a TRADE/NO_TRADE verdict', async () => {
    await seedTerminalReasonEvent({ symbol: 'TSLA', traceId: 'trace-tsla' });
    const report = await mod.buildWhyNoTradeReport('TSLA', stubGlobal());
    const text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('Symbol: TSLA');
    expect(text).toContain('Final: NO_TRADE');
  });

  it('surfaces the most recent QUANT_POLICY_REJECTED observability row with payload detail and maps it to QUANT_POLICY_REJECTED', async () => {
    await seedQuantPolicyEvent({ ts: 5000, symbol: 'QNVDA', traceId: 'trace-qnvda', reasonCode: 'SUPPORT_DIMENSIONS_INSUFFICIENT' });

    const report = await mod.buildWhyNoTradeReport('QNVDA', stubGlobal());
    expect(report.found).toBe(false); // no consensus row - preserved historical meaning
    expect(report.quant.found).toBe(true);
    expect(report.quant.eventType).toBe('QUANT_POLICY_REJECTED');
    expect(report.quant.approved).toBe(false);
    expect(report.quant.reasonCode).toBe('SUPPORT_DIMENSIONS_INSUFFICIENT');
    expect(report.quant.strategyId).toBe('MOMENTUM_BREAKOUT');
    expect(report.quant.supportSatisfied).toBe(2);
    expect(report.quant.supportRequired).toBe(3);
    expect(report.quant.checks).toHaveLength(2);
    expect(report.quant.checks[0]).toMatchObject({ id: 'support_dimensions', passed: false });
    expect(report.primaryPath).toBe('QUANT_EXECUTION');
    expect(report.mappedCategory).toBe('QUANT_POLICY_REJECTED');

    const text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('QUANT_POLICY_REJECTED');
    expect(text).toContain('SUPPORT_DIMENSIONS_INSUFFICIENT');
    expect(text).toContain('Best-fit category: QUANT_POLICY_REJECTED');
    expect(text).toContain('Final: NO_TRADE');
  });

  it('ignores noisy non-quant event types when finding the quant-policy outcome (SQL-level eventType filter)', async () => {
    await seedQuantPolicyEvent({ ts: 1000, symbol: 'QNOISE', traceId: 'trace-qnoise' });
    for (let i = 0; i < 30; i++) {
      await db.insert(schema.observabilityEvents).values({
        id: `qnoise-${i}`, ts: 2000 + i, level: 'INFO', category: 'DISCOVERY', eventType: 'SUBSCRIPTION_PROMOTED',
        loggerName: 'argus', message: 'subscription_priority_decision', sessionId: 'sess-1', symbol: 'QNOISE',
        payload: null,
      });
    }
    const report = await mod.buildWhyNoTradeReport('QNOISE', stubGlobal());
    expect(report.quant.found).toBe(true);
    expect(report.quant.traceId).toBe('trace-qnoise');
  });

  it('joins risk_assessments by traceId for a QUANT_POLICY_APPROVED idea (approved quant flows through RiskEngine)', async () => {
    await seedQuantPolicyEvent({
      ts: 6000, symbol: 'QAPL', traceId: 'trace-qapl-approved', eventType: 'QUANT_POLICY_APPROVED',
      reasonCode: 'ALL_CHECKS_PASSED', reason: 'All support dimensions satisfied',
    });
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-qapl-approved', symbol: 'QAPL', side: 'BUY', approved: false,
      rejectionGate: 'symbol_concentration', maxQuantity: 0, createdAt: new Date().toISOString(),
    });
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace-qapl-approved', gateName: 'emergency_stop', sequence: 1, passed: true },
      { traceId: 'trace-qapl-approved', gateName: 'symbol_concentration', sequence: 2, passed: false, detail: '{"current":0.22,"max":0.20}' },
    ]);

    const report = await mod.buildWhyNoTradeReport('QAPL', stubGlobal());
    expect(report.quant.found).toBe(true);
    expect(report.quant.approved).toBe(true);
    expect(report.quant.risk.reached).toBe(true);
    expect(report.quant.risk.approved).toBe(false);
    expect(report.quant.risk.rejectionGate).toBe('symbol_concentration');
    // Policy approved but RiskEngine rejected -> RISK_REJECTED wins over the approval.
    expect(report.mappedCategory).toBe('RISK_REJECTED');
  });

  it('surfaces QUANT_NOT_AUTHORIZED from trade_lifecycle_transitions DESK_NO_TRADE evidence (no observability emitter exists)', async () => {
    await seedQuantNotAuthorizedLifecycle({ symbol: 'QNA', traceId: 'trace-qna-1', quantReasonCode: 'STRATEGY_RETIRED' });

    const report = await mod.buildWhyNoTradeReport('QNA', stubGlobal());
    expect(report.found).toBe(false);
    expect(report.quant.found).toBe(true);
    expect(report.quant.eventType).toBe('QUANT_NOT_AUTHORIZED');
    expect(report.quant.approved).toBeNull(); // policy never evaluated - authorization failed first
    expect(report.quant.reasonCode).toBe('STRATEGY_RETIRED');
    expect(report.quant.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(report.quant.risk.reached).toBe(false);
    expect(report.mappedCategory).toBe('QUANT_NOT_AUTHORIZED');

    const text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('QUANT_NOT_AUTHORIZED');
    expect(text).toContain('STRATEGY_RETIRED');
  });

  it('does not mistake other DESK_NO_TRADE rows for QUANT_NOT_AUTHORIZED (evidence filter)', async () => {
    await db.insert(schema.tradeLifecycleTransitions).values({
      id: `lc-plain-${Date.now()}`, candidateId: 'trace-plain', symbol: 'QPLAIN', state: 'NO_TRADE',
      reason: 'plain no trade', source: 'ChiefTraderAgent',
      evidenceJson: JSON.stringify({ type: 'DESK_NO_TRADE', payload: { traceId: 'trace-plain', symbol: 'QPLAIN', terminalReasonCode: 'CONSENSUS_INSUFFICIENT' } }),
      latencyMs: 1, createdAt: new Date().toISOString(),
    });
    const report = await mod.buildWhyNoTradeReport('QPLAIN', stubGlobal());
    expect(report.quant.found).toBe(false);
  });

  it('prefers the newer quant outcome over an older consensus row (primaryPath), and vice versa', async () => {
    await seedTerminalReasonEvent({ ts: 1000, symbol: 'QBOTH', traceId: 'trace-qboth-consensus', terminalReasonCode: 'CONFIDENCE_BELOW_STRONG' });
    await seedQuantPolicyEvent({ ts: 2000, symbol: 'QBOTH', traceId: 'trace-qboth-quant' });
    let report = await mod.buildWhyNoTradeReport('QBOTH', stubGlobal());
    expect(report.found).toBe(true);
    expect(report.quant.found).toBe(true);
    expect(report.primaryPath).toBe('QUANT_EXECUTION');
    expect(report.mappedCategory).toBe('QUANT_POLICY_REJECTED');
    let text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('Path: QUANT_EXECUTION');
    expect(text).toContain('Consensus: FAIL (CONFIDENCE_BELOW_STRONG)');

    await seedQuantPolicyEvent({ ts: 500, symbol: 'QBOTH2', traceId: 'trace-qboth2-quant' });
    await seedTerminalReasonEvent({ ts: 3000, symbol: 'QBOTH2', traceId: 'trace-qboth2-consensus', terminalReasonCode: 'INSUFFICIENT_AGENT_PARTICIPATION' });
    report = await mod.buildWhyNoTradeReport('QBOTH2', stubGlobal());
    expect(report.primaryPath).toBe('CONSENSUS');
    expect(report.mappedCategory).toBe('CONSENSUS_INSUFFICIENT');
    text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('Consensus: FAIL (INSUFFICIENT_AGENT_PARTICIPATION)');
    expect(text).toContain('Quant path: QUANT_POLICY_REJECTED');
  });

  it('leads with global state when no terminal evaluation exists at all - TRADING_PAUSED is the category', async () => {
    const report = await mod.buildWhyNoTradeReport('GHOST2', stubGlobal({
      tradingState: 'TRADING_PAUSED', autobotEnabled: true, emergencyStopActive: false,
      broker: { id: 'alpaca-paper', ready: true, detail: 'alpaca-paper: Healthy' },
      marketData: { allocatedLines: 120, receivingLines: 118, freshLines: 115, staleLines: 3, errorLines: 2, entitlementFailures: 0, contractFailures: 1 },
    }));
    expect(report.found).toBe(false);
    expect(report.quant.found).toBe(false);
    expect(report.mappedCategory).toBe('TRADING_PAUSED');

    const text = mod.formatWhyNoTradeReport(report);
    const lines = text.split('\n');
    const tradingIdx = lines.findIndex((l) => l.startsWith('Trading state:'));
    const noEvalIdx = lines.findIndex((l) => l.includes('No CONSENSUS_TERMINAL_REASON'));
    expect(tradingIdx).toBeGreaterThanOrEqual(0);
    expect(noEvalIdx).toBeGreaterThan(tradingIdx); // global state leads
    expect(text).toContain('Trading state: TRADING_PAUSED');
    expect(text).toContain('Broker: alpaca-paper - READY');
    expect(text).toContain('120 allocated / 118 receiving (115 fresh, 3 stale) / 2 error');
    expect(text).toContain('argus market-data-diagnostics --symbols=<SYM>');
    expect(text).toContain('Best-fit category: TRADING_PAUSED');
  });

  it('maps broker-not-ready to BROKER_UNAVAILABLE even with no terminal evaluation', async () => {
    const report = await mod.buildWhyNoTradeReport('GHOST3', stubGlobal({
      tradingState: 'TRADING_ENABLED',
      broker: { id: 'ibkr_gateway', ready: false, detail: 'ibkr_gateway: OFFLINE' },
    }));
    expect(report.mappedCategory).toBe('BROKER_UNAVAILABLE');
    const text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('Broker: ibkr_gateway - NOT READY (ibkr_gateway: OFFLINE)');
  });

  it('readGlobalTradingState degrades to nulls (never throws) in an environment without the runtime', async () => {
    const g = await mod.readGlobalTradingState();
    expect(g).toBeDefined();
    // In the vitest env the engine/runtime singletons are not booted - the point is it does not throw.
  }, 15000);
});
