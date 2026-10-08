/**
 * Phase 41 — Protective-exit AI independence.
 *
 * Protective exits (PortfolioMonitor stop/target/thesis-invalidation SELL ideas, agent name
 * 'PortfolioManager' per config/agentWeights.json riskExitAgent; and the PipelineFlatten
 * liquidate override) are capital-preservation actions. They must be approvable with ZERO AI
 * involvement and must never wait on, consult, or be gated by Jev/AICallGovernor — including
 * when the governor's circuit is OPEN.
 *
 * Terminology note (verified 2026-10-07): there is NO PortfolioManager.ts module. The
 * protective-exit decision path is:
 *   PortfolioMonitor.ts  -> emits the PORTFOLIO_EXIT SELL idea (agent 'PortfolioManager')
 *   ChiefTraderAgent.ts  -> isRiskExit() branch in reviewIdea(): skips debate/min-agents,
 *                           schedules immediate consensus evaluation
 *   PipelineFlatten.ts   -> documented liquidate override, still requires RiskEngine/OMS
 * Assertions below target exactly those three code paths.
 *
 * WHAT IS ASSERTED:
 *  1. PortfolioMonitor.ts and PipelineFlatten.ts never import or await
 *     JevDecisionProvider/AICallGovernor (comments stripped first).
 *  2. ChiefTraderAgent's risk-exit branch specifically — the isRiskExit() predicate body and
 *     the reviewIdea() early-return block for risk exits — contains no routeTask/routeConsensus
 *     call and no Jev/AICallGovernor/AiAdvisoryService reference. (Whole-file assertion would
 *     be wrong: ChiefTrader legitimately uses AIRouter in the non-exit consensus/debate path.)
 *  3. RUNTIME (skipped until AICallGovernor lands): a risk-exit SELL idea with the governor
 *     circuit OPEN is still approved without delay — the exit path never consults the
 *     governor at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from 'node:path';

const ROOT = process.cwd();

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const JEV_IDENTIFIERS = ['JevDecisionProvider', 'AICallGovernor', 'AiAdvisoryService'];

function expectNoJevReference(text: string, label: string): void {
  for (const id of JEV_IDENTIFIERS) {
    expect(text, `${label} must not reference ${id}`).not.toContain(id);
  }
  expect(text, `${label} must not import a Jev module`).not.toMatch(
    /from\s+['"][^'"]*(JevDecisionProvider|AICallGovernor|AiAdvisoryService)['"]/,
  );
  expect(text, `${label} must not await a Jev/governor call`).not.toMatch(
    /await\s+(jev|governor)[\w.]*\(/i,
  );
}

describe('Protective-exit AI independence (static)', () => {
  it('PortfolioMonitor.ts never imports or awaits JevDecisionProvider/AICallGovernor', () => {
    const text = stripComments(readFileSync(join(ROOT, 'src/server/services/PortfolioMonitor.ts'), 'utf8'));
    expectNoJevReference(text, 'PortfolioMonitor.ts');
  });

  it('PipelineFlatten.ts never imports or awaits JevDecisionProvider/AICallGovernor', () => {
    const text = stripComments(readFileSync(join(ROOT, 'src/server/services/PipelineFlatten.ts'), 'utf8'));
    expectNoJevReference(text, 'PipelineFlatten.ts');
  });

  it('ChiefTraderAgent risk-exit branch never routes to AI (isRiskExit + reviewIdea early-return)', () => {
    const raw = readFileSync(join(ROOT, 'src/server/services/ChiefTraderAgent.ts'), 'utf8');

    // (a) the risk-exit predicate itself. The signature's type annotation contains braces,
    // so the pattern matches the signature loosely and captures up to the method's
    // closing brace at 2-space indent.
    const pred = raw.match(/private isRiskExit\(.*?\)[\s\S]*?\{([\s\S]*?)\n  \}/);
    expect(pred, 'expected to find isRiskExit() predicate').toBeTruthy();
    expectNoJevReference(stripComments(pred![1]), 'isRiskExit()');
    expect(pred![1]).not.toContain('routeTask(');
    expect(pred![1]).not.toContain('routeConsensus(');

    // (b) the reviewIdea() risk-exit early-return block: exits must not wait for debate or AI.
    // Anchored on the RAW text (not comment-stripped): the anchor IS a comment, and the
    // identifier assertions run on the stripped capture.
    const block = raw.match(
      /\/\/ PortfolioMonitor stop\/target\/invalidation exits must not wait[\s\S]*?if\s*\(this\.isRiskExit\(idea\)\)\s*\{([\s\S]*?)\n    \}/,
    );
    expect(block, 'expected to find the reviewIdea() risk-exit early-return block').toBeTruthy();
    const blockBody = stripComments(block![1]);
    expectNoJevReference(blockBody, 'reviewIdea() risk-exit block');
    expect(blockBody).not.toContain('routeTask(');
    expect(blockBody).not.toContain('routeConsensus(');
    expect(blockBody).toMatch(/scheduleConsensusEvaluation/);
  });
});

describe('Protective-exit AI independence (runtime)', () => {
  // Against the REAL AICallGovernor contract (sibling landed 2026-10-07):
  //   AICallGovernor.getInstance().__setJevProviderForTests(fake)  — fake implements
  //     { isConfigured(), decide(req) }; decide() throws the real JevError{kind}.
  //   5 consecutive tripping-kind failures (jevConsecutiveFailureThreshold) -> circuit OPEN;
  //   further requests -> { status:'SKIPPED', reason:'CIRCUIT_OPEN' } with zero provider calls.
  // The exit path is then proven to never consult the governor at all (spy on request).
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let EVENTS: any;
  let chiefTrader: any;
  let BrokerManager: any;
  let marketDataWorker: any;
  let governor: any;
  let governorCtor: any;
  let JevError: any;

  const approvals: any[] = [];

  async function waitFor(cond: () => boolean, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function governorRequest(i: number, symbol = 'AAPL') {
    return governor.request({
      capability: 'STRUCTURED_DECISION',
      kind: 'news_catalyst_triage',
      material: {
        symbol,
        fingerprintParts: { event: 'protective-exit-circuit', i },
        materiality: 'HIGH',
        decisionDeadlineMs: Date.now() + 60_000,
        traceId: `synthetic-exit-circuit-${i}`,
      },
      jev: { state: { synthetic: true }, questions: { material: 'is this material?' }, schemaVersion: '1' },
      // Required by the type; the governor builds the Jev call itself for STRUCTURED_DECISION
      // and must NEVER invoke this (no automatic failover, ever).
      run: async () => ({ value: null, cacheable: false }),
    });
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_exit_ai_indep_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    process.env.QUANT_ENGINE_ENABLED = 'true';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    EVENTS = (await import('../core/eventNames')).EVENTS;
    const { ChiefTraderAgent } = await import('../services/ChiefTraderAgent');
    await import('../services/RiskAgent'); // module singleton — import exactly once per file
    await import('../services/OrderManagement'); // module singleton — import exactly once per file
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    const { tradingEngine } = await import('../engines/TradingEngine');
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    const { getTradingDateStr } = await import('../core/TradingCalendar');
    ({ AICallGovernor: governorCtor } = await import('./AICallGovernor'));
    ({ JevError } = await import('./JevDecisionProvider'));
    governor = governorCtor.getInstance();

    await db.insert(schema.settings).values({
      tradingMode: 'Paper', autoBotEnabled: true, budget: 100000, maxTradeSize: 3000,
    });
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    marketDataWorker.cacheObservedQuote('AAPL', 150);

    chiefTrader = new ChiefTraderAgent();
    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => approvals.push(a));
  }, 60000);

  afterAll(() => {
    try { governor?.resetForTests(); } catch { /* never mask the real result */ }
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.PAPER_TRADING_ONLY;
    delete process.env.QUANT_ENGINE_ENABLED;
  });

  beforeEach(async () => {
    // Drain fire-and-forget advisory work: it shares the governor singleton and a
    // late-settling advisory from a prior test would trip the fresh circuit early.
    try { (await import('./AiAdvisoryService')).aiAdvisoryService.drainPendingAdvisoryWork(); } catch { /* best-effort */ }
    governor.resetForTests();
  });

  afterEach(async () => {
    try { (await import('./AiAdvisoryService')).aiAdvisoryService.drainPendingAdvisoryWork(); } catch { /* best-effort */ }
    governor.resetForTests();
    vi.restoreAllMocks();
  });

  it('risk-exit SELL idea with governor circuit OPEN is still approved without delay and never consults the governor (SYNTHETIC_SEEDED)', async () => {
    // 1. Drive the real governor circuit OPEN: 5 consecutive OVERLOAD failures.
    let providerInvocations = 0;
    governor.__setJevProviderForTests({
      isConfigured: () => true,
      decide: async () => {
        providerInvocations++;
        throw new JevError('OVERLOAD', 'synthetic Jev overload (SYNTHETIC_SEEDED)');
      },
    });
    for (let i = 0; i < 5; i++) {
      // Distinct symbols: the governor stamps the 5-minute per-symbol cooldown at
      // SHOULD_CALL even when the call fails, so reusing one symbol would mask the
      // circuit behind SYMBOL_COOLDOWN skips (which never reach the provider and
      // therefore never count toward the breaker).
      const res = await governorRequest(i, `CIRCUIT_SAT_${i}`);
      expect(res.status).toBe('FAILED');
      expect((res as any).kind).toBe('OVERLOAD');
    }
    expect(providerInvocations).toBe(5);
    expect(governor.getDiagnostics().circuits.jev).toBe('OPEN');

    // 2. Circuit is open: the next request skips without touching the provider.
    const probe = await governorRequest(999);
    expect(probe.status).toBe('SKIPPED');
    expect((probe as any).reason).toBe('CIRCUIT_OPEN');
    expect(providerInvocations).toBe(5);

    // 3. The protective exit must not consult the governor at all — spy to prove it.
    const requestSpy = vi.spyOn(governor, 'request');

    const traceId = `synthetic-risk-exit-${Date.now()}`;
    const startedAt = Date.now();
    await chiefTrader.reviewIdea({
      traceId,
      symbol: 'AAPL',
      side: 'SELL',
      confidence: 0.9,
      currentPrice: 150,
      reasoning: 'SYNTHETIC_SEEDED (NON_ORGANIC): protective exit — stop hit. Governor circuit is OPEN.',
      agent: 'PortfolioManager', // riskExitAgent per config/agentWeights.json
      origin: 'PORTFOLIO_EXIT',
    });

    await waitFor(() => approvals.some((a: any) => a.traceId === traceId), 15000, 'exit CHIEF_APPROVED_IDEA');
    const approval = approvals.find((a: any) => a.traceId === traceId);
    expect(approval.side).toBe('SELL');
    const elapsedMs = Date.now() - startedAt;
    // No AI round-trip is possible on this path (proven statically above); the approval
    // must land far below any LLM deadline even with the circuit open.
    expect(elapsedMs).toBeLessThan(15000);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(providerInvocations).toBe(5);
    console.log(
      `[protective-exit] circuit OPEN, risk-exit SELL approved in ${elapsedMs}ms, ` +
      `governor.request calls during exit: ${requestSpy.mock.calls.length}, provider invocations: ${providerInvocations}`,
    );
  }, 90000);

  it('the runtime exit suite is live: AICallGovernor contract present', () => {
    expect(typeof governor.request).toBe('function');
    expect(typeof governor.__setJevProviderForTests).toBe('function');
  });
});
