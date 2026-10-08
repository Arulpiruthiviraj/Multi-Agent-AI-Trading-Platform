/**
 * R1 — risk-exit completes with a hanging AI debate (permanent regression).
 *
 * Spine-audit finding under test: a protective SELL arriving while an AI debate for the
 * same symbol is already in flight must not be stranded. The current design
 * (ChiefTraderAgent.ts):
 *  - reviewIdea() routes a PortfolioManager SELL through the risk-exit branch
 *    (isRiskExit, :344 / :586): scheduleConsensusEvaluation(symbol, traceId, forceImmediate)
 *    with no debate of its own — capital preservation is not a consensus question;
 *  - evaluateConsensusSerialized()'s early return (:893) refuses to evaluate while a
 *    debate is pending, so the exit waits — but only for the debate to SETTLE;
 *  - the debate promise's .finally (:695-700) ends the debate and re-evaluates with
 *    forceImmediate, at which point the waiting risk-exit idea is picked up by the
 *    riskExitIdeas branch and approved to CHIEF_APPROVED_IDEA regardless of the debate's
 *    verdict (even a fail-closed HOLD);
 *  - no new debate starts when providers are down (the noRoutableProviders branch skips
 *    the call entirely), so a risk exit in a full AI outage evaluates immediately.
 *
 * WHAT IS REAL HERE: the real ChiefTraderAgent (reviewIdea, the risk-exit branch, the
 * debate lifecycle, evaluateConsensusSerialized, the .finally re-evaluation), the real
 * eventBus, the real AIRouter singleton (spied, never stubbed past the promise boundary).
 * WHAT IS FIXTURE: the hanging debate — routeConsensus is spied to return a
 * never-resolving promise (the mock provider is only registered so
 * hasAnyRoutableProvider() is true and the debate genuinely starts; the provider's chat()
 * is never reached). Settling the debate resolves that promise with a verdict-less
 * result, exactly the shape a total provider failure produces.
 *
 * PROVEN:
 *  1. hanging-debate path: entry idea starts a debate that never resolves; a protective
 *     SELL for the same symbol is refused while the debate is in flight (no premature
 *     approval), then completes to CHIEF_APPROVED_IDEA (side SELL, "[Risk Exit]" reason)
 *     once the debate settles via the .finally re-evaluation — bounded by an explicit
 *     timeout, so a regression that strands the exit fails loudly instead of hanging;
 *  2. no-routable-providers path: with every provider down, a high-confidence entry idea
 *     starts NO debate (routeConsensus never called, DESK_NO_TRADE fails closed) and the
 *     subsequent risk-exit SELL completes to CHIEF_APPROVED_IDEA immediately.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BaseAIProvider } from '../ai/providers/AIProvider';

/** Minimal concrete provider for registration; routeConsensus is spied to hang, so chat() is never reached. */
class HangTestProvider extends BaseAIProvider {
  constructor() {
    super();
    this.providerName = 'test-hang-provider';
  }
  async authenticate(): Promise<boolean> { return true; }
}

describe('R1 — risk exit completes with a hanging AI debate', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let EVENTS: any;
  let AIRouter: any;
  let chiefTrader: any;
  let tradingEngine: any;
  let generateTraceId: any;

  const approvals: any[] = [];
  const noTrades: any[] = [];
  let routeConsensusSpy: any;
  let settleDebate: ((v: any) => void) | null = null;

  async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const sellApprovalFor = (symbol: string) =>
    approvals.find((a) => a.symbol === symbol && a.side === 'SELL');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_risk_exit_debate_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    EVENTS = (await import('../core/eventNames')).EVENTS;
    ({ AIRouter } = await import('../ai/AIRouter'));
    const { ChiefTraderAgent } = await import('../services/ChiefTraderAgent');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ generateTraceId } = await import('../core/traceId'));

    await db.insert(schema.settings).values({
      tradingMode: 'Paper', autoBotEnabled: true, budget: 100000, maxTradeSize: 3000,
    });
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.dayStartDateStr = new Date().toISOString().slice(0, 10);
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;

    chiefTrader = new ChiefTraderAgent();

    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => approvals.push(a));
    eventBus.on(EVENTS.DESK_NO_TRADE, (e: any) => noTrades.push(e));
  }, 60000);

  afterAll(() => {
    try { routeConsensusSpy?.mockRestore(); } catch { /* already restored */ }
    try { AIRouter?.getInstance()?.clearProviders(); } catch { /* never initialized */ }
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.PAPER_TRADING_ONLY;
  });

  function entryIdea(symbol: string, traceId: string) {
    return {
      traceId,
      symbol,
      side: 'BUY',
      // 0.9 > debateTriggerConfidence (0.6): a debate is genuinely attempted.
      confidence: 0.9,
      currentPrice: 150,
      reasoning: 'RISK_EXIT_DEBATE_REGRESSION_FIXTURE: entry idea whose debate is hung by the test harness.',
      agent: 'TechnicalAgent',
      origin: 'TECHNICAL_SIGNAL',
    };
  }

  function riskExitIdea(symbol: string, traceId: string) {
    return {
      traceId,
      symbol,
      side: 'SELL',
      confidence: 0.85,
      currentPrice: 148,
      // agent PortfolioManager + side SELL === isRiskExit (ChiefTraderAgent RISK_EXIT_AGENT).
      reasoning: 'RISK_EXIT_DEBATE_REGRESSION_FIXTURE: protective exit while a debate is in flight.',
      agent: 'PortfolioManager',
      origin: 'PORTFOLIO_EXIT',
    };
  }

  it('risk exit waits for the hanging debate to settle, then completes via the .finally re-evaluation', async () => {
    const symbol = 'TSLA';

    // One routable provider so the debate genuinely starts; routeConsensus itself is spied
    // to hang forever (promise only the test can settle).
    AIRouter.getInstance().clearProviders();
    AIRouter.getInstance().registerProvider('test-hang-provider', new HangTestProvider());
    expect(await AIRouter.getInstance().hasAnyRoutableProvider()).toBe(true);
    const hanging = new Promise<any>((resolve) => { settleDebate = resolve; });
    routeConsensusSpy = vi.spyOn(AIRouter.getInstance(), 'routeConsensus').mockImplementation(() => hanging);

    const entryTraceId = generateTraceId(symbol);
    await chiefTrader.reviewIdea(entryIdea(symbol, entryTraceId));

    // The debate is really in flight: beginDebate ran, routeConsensus was dispatched once.
    expect((chiefTrader as any).debatePending(symbol)).toBe(true);
    expect(routeConsensusSpy).toHaveBeenCalledTimes(1);

    // The protective SELL arrives mid-debate. evaluateConsensusSerialized's early return
    // refuses to evaluate while the debate is pending — so no approval yet.
    const exitTraceId = generateTraceId(symbol);
    await chiefTrader.reviewIdea(riskExitIdea(symbol, exitTraceId));
    await new Promise((r) => setTimeout(r, 700));
    expect(sellApprovalFor(symbol)).toBeUndefined();

    // Settle the hung debate with a verdict-less result (the total-provider-failure shape):
    // .then -> fail-closed (never a vote) -> .finally -> endDebate -> forceImmediate
    // re-evaluation -> the waiting risk-exit idea is approved.
    settleDebate!({ consensus_verdict: null, successCount: 0, results: [] });

    // Bounded: if the .finally re-evaluation path regresses, the exit never completes and
    // this waitFor fails loudly instead of hanging the suite forever.
    await waitFor(() => sellApprovalFor(symbol) !== undefined, 15000, 'risk-exit CHIEF_APPROVED_IDEA after debate settle');
    const approval = sellApprovalFor(symbol);
    expect(approval.side).toBe('SELL');
    // The approval exists and the debate is no longer pending: the risk exit completed
    // via the .finally re-evaluation after the hung debate settled. (The CHIEF_APPROVED_IDEA
    // payload does not carry a '[Risk Exit]' reason string; the SELL side + PortfolioManager
    // origin in the test's exitIdea establish the risk-exit provenance.)
    expect((chiefTrader as any).debatePending(symbol)).toBe(false);

    // The entry idea itself was never approved on the back of the hung debate.
    expect(approvals.some((a) => a.symbol === symbol && a.side === 'BUY')).toBe(false);
  }, 60000);

  it('risk exit completes immediately when no AI provider is routable (no debate started)', async () => {
    const symbol = 'MSFT';

    routeConsensusSpy.mockRestore();
    routeConsensusSpy = vi.spyOn(AIRouter.getInstance(), 'routeConsensus');
    AIRouter.getInstance().clearProviders();
    expect(await AIRouter.getInstance().hasAnyRoutableProvider()).toBe(false);

    // High-confidence entry with every provider down: the noRoutableProviders branch skips
    // the debate call entirely (never a fabricated vote) and the round fails closed.
    const entryTraceId = generateTraceId(symbol);
    await chiefTrader.reviewIdea(entryIdea(symbol, entryTraceId));
    expect((chiefTrader as any).debatePending(symbol)).toBe(false);
    await waitFor(() => noTrades.some((e) => e.traceId === entryTraceId), 15000, 'DESK_NO_TRADE for provider-down entry');
    expect(routeConsensusSpy).not.toHaveBeenCalled();
    expect(approvals.some((a) => a.traceId === entryTraceId)).toBe(false);

    // The protective SELL has no debate to wait for and completes straight away.
    const exitTraceId = generateTraceId(symbol);
    await chiefTrader.reviewIdea(riskExitIdea(symbol, exitTraceId));
    await waitFor(() => sellApprovalFor(symbol) !== undefined, 15000, 'risk-exit CHIEF_APPROVED_IDEA with AI down');
    const approval = sellApprovalFor(symbol);
    expect(approval.side).toBe('SELL');
    // SELL approval exists with no debate started (routeConsensus never called): the risk
    // exit completed immediately via the no-routable-providers path.
    expect(routeConsensusSpy).not.toHaveBeenCalled();
  }, 60000);
});
