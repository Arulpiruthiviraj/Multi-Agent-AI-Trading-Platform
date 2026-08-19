import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    all() { return Promise.resolve([]); },
    then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  const mockDb = {
    select: () => builder,
    insert: () => ({ values: () => Promise.resolve({}) }),
  };
  return { mockDb };
});

const { emitChiefApproval } = vi.hoisted(() => ({ emitChiefApproval: vi.fn() }));
const { routeConsensus, routeTask } = vi.hoisted(() => ({ routeConsensus: vi.fn(), routeTask: vi.fn() }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus, routeTask }) } }));
const { ideaGenEnabled } = vi.hoisted(() => ({ ideaGenEnabled: { value: true } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value }));

import { ChiefTraderAgent, CONSENSUS_APPROVAL_THRESHOLD, MIN_INDEPENDENT_AGREEING_AGENTS } from './ChiefTraderAgent';
import { DISAGREEMENT_PENALTY, netConfidenceFromVotes } from './EvidenceAggregator';
import { defaultAgentWeights, agentWeightConfig } from '../config/agentWeights';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { bullBearResearchConfig } from '../config/bullBearResearch';

const fixtures = loadRepoConfigJson<{
  strongAgreementConfidence: number;
  weakDisagreementConfidence: number;
  splitConfidence: number;
  belowThresholdConfidence: number;
  unweightedAgentConfidence: number;
}>('consensusFixtures.json');
const w = defaultAgentWeights;

function buyPair(symbol: string, confidence: number, extra: Record<string, unknown> = {}) {
  return [
    { traceId: 't', symbol, side: 'BUY', confidence, agent: 'TechnicalAgent', reasoning: 'tech', ...extra },
    { traceId: 't', symbol, side: 'BUY', confidence, agent: 'NewsAgent', reasoning: 'news' },
  ];
}

describe('ChiefTraderAgent.evaluateConsensus', () => {
  let agent: any;

  beforeEach(() => {
    emitChiefApproval.mockClear();
    routeConsensus.mockReset();
    routeTask.mockReset();
    ideaGenEnabled.value = true;
    agent = new ChiefTraderAgent();
    agent.agentWeights = { ...defaultAgentWeights };
    agent.recentIdeas = [];
  });

  it('does not approve a strong single-agent idea - one voice is not independent confirmation', async () => {
    agent.recentIdeas = [
      { traceId: 't1', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong momentum' },
    ];

    await agent.evaluateConsensus('AAPL', 't1');

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it(`approves when two independent agents agree and weighted confidence clears the configured threshold`, async () => {
    agent.recentIdeas = buyPair('AAPL', 0.95);

    await agent.evaluateConsensus('AAPL', 't1');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.side).toBe('BUY');
    expect(approval.confidence).toBeCloseTo(0.95, 5);
  });

  it('does not approve when weighted confidence stays at or below the configured approval threshold', async () => {
    agent.recentIdeas = [
      { traceId: 't2', symbol: 'AAPL', side: 'BUY', confidence: fixtures.belowThresholdConfidence, agent: 'TechnicalAgent', reasoning: 'weak signal' },
    ];

    await agent.evaluateConsensus('AAPL', 't2');

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('reduces weighted confidence when agents disagree, but still approves if it clears the configured threshold', async () => {
    agent.recentIdeas = [
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: fixtures.strongAgreementConfidence, agent: 'TechnicalAgent', reasoning: 'buy A' },
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: fixtures.strongAgreementConfidence, agent: 'NewsAgent', reasoning: 'buy B' },
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: fixtures.strongAgreementConfidence, agent: 'FundamentalAgent', reasoning: 'buy C' },
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: fixtures.strongAgreementConfidence, agent: 'QuantEngine', reasoning: 'buy D' },
      { traceId: 't3', symbol: 'AAPL', side: 'SELL', confidence: fixtures.weakDisagreementConfidence, agent: 'KronosEngine', reasoning: 'weak sell' },
    ];

    await agent.evaluateConsensus('AAPL', 't3');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.side).toBe('BUY');
    const expectedWithDisagreement = netConfidenceFromVotes(
      [
        { confidence: fixtures.strongAgreementConfidence, weight: w.TechnicalAgent },
        { confidence: fixtures.strongAgreementConfidence, weight: w.NewsAgent },
        { confidence: fixtures.strongAgreementConfidence, weight: w.FundamentalAgent },
        { confidence: fixtures.strongAgreementConfidence, weight: w.QuantEngine },
      ],
      [{ confidence: fixtures.weakDisagreementConfidence, weight: w.KronosEngine }],
    );
    expect(approval.confidence).toBeCloseTo(expectedWithDisagreement, 4);
    expect(approval.confidence).toBeLessThan(fixtures.strongAgreementConfidence);
    expect(approval.confidence).toBeGreaterThan(CONSENSUS_APPROVAL_THRESHOLD);
  });

  it('does not approve at all when disagreement pulls the winning side at/below the configured approval bar', async () => {
    agent.recentIdeas = [
      { traceId: 't4', symbol: 'AAPL', side: 'BUY', confidence: fixtures.splitConfidence, agent: 'TechnicalAgent', reasoning: 'buy A' },
      { traceId: 't4', symbol: 'AAPL', side: 'BUY', confidence: fixtures.splitConfidence, agent: 'NewsAgent', reasoning: 'buy B' },
      { traceId: 't4', symbol: 'AAPL', side: 'SELL', confidence: fixtures.splitConfidence, agent: 'MacroAgent', reasoning: 'sell C' },
    ];

    await agent.evaluateConsensus('AAPL', 't4');

    const expected = netConfidenceFromVotes(
      [{ confidence: fixtures.splitConfidence, weight: w.TechnicalAgent }, { confidence: fixtures.splitConfidence, weight: w.NewsAgent }],
      [{ confidence: fixtures.splitConfidence, weight: w.MacroAgent }],
    );
    expect(expected).toBeLessThanOrEqual(CONSENSUS_APPROVAL_THRESHOLD);
    expect(DISAGREEMENT_PENALTY).toBeGreaterThan(0);
    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('gives an unweighted agent (not in agentWeights) a default weight of 1.0', async () => {
    agent.recentIdeas = [
      { traceId: 't5', symbol: 'AAPL', side: 'BUY', confidence: fixtures.unweightedAgentConfidence, agent: 'BrandNewAgent', reasoning: 'novel signal' },
      { traceId: 't5', symbol: 'AAPL', side: 'BUY', confidence: fixtures.unweightedAgentConfidence, agent: 'NewsAgent', reasoning: 'news confirm' },
    ];

    await agent.evaluateConsensus('AAPL', 't5');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.confidence).toBeCloseTo(fixtures.unweightedAgentConfidence, 5);
    expect(approval.agentsContext).toContain('BrandNewAgent(wt:1.00)');
  });

  it('gives the ConsensusDebate pseudo-agent a default weight of 0.35 when unweighted, but debate alone is not independent confirmation', async () => {
    agent.recentIdeas = [
      { traceId: 't6', symbol: 'AAPL', side: 'BUY', confidence: 0.9, agent: 'ConsensusDebate', reasoning: 'debate result' },
      { traceId: 't6', symbol: 'AAPL', side: 'BUY', confidence: 0.9, agent: 'TechnicalAgent', reasoning: 'tech' },
    ];

    await agent.evaluateConsensus('AAPL', 't6');

    // ConsensusDebate does not count toward the two-independent-agent floor, so this stays NO TRADE.
    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('does not approve when the adversarial debate votes HOLD, even if two agents agree on BUY', async () => {
    agent.recentIdeas = [
      ...buyPair('AAPL', 0.95),
      { traceId: 't', symbol: 'AAPL', side: 'HOLD', confidence: 0.8, agent: 'ConsensusDebate', reasoning: 'debate hold' },
    ];

    await agent.evaluateConsensus('AAPL', 'thold');

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('does not approve when QuantEngine AI contradiction review disagrees with the side', async () => {
    agent.recentIdeas = [
      {
        traceId: 't7b', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'QuantEngine', reasoning: 'quant setup',
        quantDetail: {
          regime: { regime: 'BULLISH_TREND' },
          strategyEvaluation: { strategy: 'MOMENTUM_BREAKOUT', invalidationConditions: [], applicableRegimes: ['BULLISH_TREND'], stop: { price: 145 }, target: { price: 165 } },
          groupedScores: { overallSetupScore: 78 },
          contradictions: [],
          aiContradictionAnalysis: { available: true, aiAgreesWithSide: false, additionalContradictions: ['tape is rolling over'], scenarioAnalysis: 'disagrees', disagreementNote: 'AI disagrees' },
        },
      },
      { traceId: 't7b', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'NewsAgent', reasoning: 'news' },
    ];

    await agent.evaluateConsensus('AAPL', 't7b');

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('approves a PortfolioManager SELL immediately as a risk exit without a second confirming agent', async () => {
    agent.recentIdeas = [
      { traceId: 'exit-1', symbol: 'AAPL', side: 'SELL', confidence: fixtures.splitConfidence, agent: agentWeightConfig.riskExitAgent, reasoning: 'Hard stop hit.', currentPrice: 90 },
    ];

    await agent.evaluateConsensus('AAPL', 'exit-1');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.side).toBe('SELL');
    expect(approval.reasoning).toContain('Risk Exit');
  });

  it('reviewIdea does not evaluate consensus while a debate is in flight, even if a later low-confidence idea arrives', async () => {
    let finishDebate: (value: any) => void = () => {};
    routeConsensus.mockImplementation(() => new Promise(resolve => { finishDebate = resolve; }));

    await agent.reviewIdea({ traceId: 'd1', symbol: 'MSFT', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong' });
    await agent.reviewIdea({ traceId: 'd2', symbol: 'MSFT', side: 'BUY', confidence: 0.55, agent: 'MacroAgent', reasoning: 'weak follow-up' });

    expect(emitChiefApproval).not.toHaveBeenCalled();

    finishDebate({
      consensus_verdict: 'BUY',
      successCount: 2,
      results: [{ status: 'success' }, { status: 'success' }],
    });
    const deadline = Date.now() + 2000;
    while (emitChiefApproval.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }

    // Two independent agents (Technical + Macro) plus debate BUY - should approve once debate settles.
    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
  });

  it('does not approve when adversarial debate throws (fail-closed HOLD)', async () => {
    routeConsensus.mockRejectedValue(new Error('llm down'));

    await agent.reviewIdea({ traceId: 'df1', symbol: 'NVDA', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong' });
    await agent.reviewIdea({ traceId: 'df1', symbol: 'NVDA', side: 'BUY', confidence: 0.55, agent: 'NewsAgent', reasoning: 'confirm' });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (agent.recentIdeas.some((i: any) => i.agent === 'ConsensusDebate' && i.side === 'HOLD')) break;
      await new Promise(r => setTimeout(r, 20));
    }

    expect(emitChiefApproval).not.toHaveBeenCalled();
    expect(agent.recentIdeas.some((i: any) => i.agent === 'ConsensusDebate' && i.side === 'HOLD')).toBe(true);
  });

  it('does not approve when adversarial debate returns no verdict (fail-closed HOLD)', async () => {
    routeConsensus.mockResolvedValue({});

    await agent.reviewIdea({ traceId: 'df2', symbol: 'AMD', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong' });
    await agent.reviewIdea({ traceId: 'df2', symbol: 'AMD', side: 'BUY', confidence: 0.55, agent: 'NewsAgent', reasoning: 'confirm' });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (agent.recentIdeas.some((i: any) => i.agent === 'ConsensusDebate' && i.side === 'HOLD')) break;
      await new Promise(r => setTimeout(r, 20));
    }

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('Phase 8: attaches real structured supportingQuantDetail when QuantEngine contributed evidence, without ever changing the deterministic side/confidence', async () => {
    agent.recentIdeas = [
      {
        traceId: 't7', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'QuantEngine', reasoning: 'quant setup', currentPrice: 150,
        quantDetail: {
          regime: { regime: 'BULLISH_TREND', trendStrength: 80, volatility: 'NORMAL', marketStructure: 'TRENDING', confidence: 0.85, features: {}, insufficientData: false },
          strategyEvaluation: {
            strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', setupScore: 90, confidence: 0.9,
            conditionsMet: ['a'], conditionsFailed: [], contradictions: ['Elevated RSI'],
            invalidationConditions: ['Price closes back below the broken level.'],
            stop: { price: 145, basis: 'test stop' }, target: { price: 165, basis: 'test target' },
            applicableRegimes: ['BULLISH_TREND'],
          },
          groupedScores: { trendScore: 85, momentumScore: 80, volatilityScore: 50, volumeScore: 75, vwapScore: 70, marketScore: 65, sectorScore: 70, relativeStrengthScore: 75, priceStructureScore: 80, overallSetupScore: 78, dataCompletePct: 90 },
          contradictions: ['Elevated RSI'],
          aiContradictionAnalysis: { available: true, aiAgreesWithSide: true, additionalContradictions: ['Broader tape looks choppy.'], scenarioAnalysis: 'Real confluence with some risk.', disagreementNote: null },
        },
      },
      { traceId: 't7', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'NewsAgent', reasoning: 'news confirm', currentPrice: 150 },
    ];

    await agent.evaluateConsensus('AAPL', 't7');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    // The deterministic side/confidence are exactly what QuantEngine's own evidence computed -
    // never altered by anything in supportingQuantDetail or the AI review it carries.
    expect(approval.side).toBe('BUY');
    expect(approval.confidence).toBeCloseTo(0.95, 5);

    const detail = approval.supportingQuantDetail;
    expect(detail).toBeDefined();
    expect(detail.selectedStrategy).toBe('MOMENTUM_BREAKOUT');
    expect(detail.regime.regime).toBe('BULLISH_TREND');
    expect(detail.setupScores.overallSetupScore).toBe(78);
    expect(detail.invalidationConditions).toContain('Price closes back below the broken level.');
    // Phase 16F fix: strategyEvaluation.stop/.target are LevelSuggestion objects ({price, basis}) -
    // proposedStop/proposedTarget must be the real numeric price a live consumer (RiskAgent ->
    // trades.quantStopPrice/quantTargetPrice) can actually compare against, not the whole object.
    expect(detail.proposedStop).toBe(145);
    expect(detail.proposedTarget).toBe(165);
    expect(detail.proposedEntry).toBe(150);
    expect(detail.expectedHoldingPeriod).toContain('Short-term');
    // Both the deterministic contradiction AND the AI's own additional one are preserved together
    // - the AI's qualitative read is recorded, never used to replace the deterministic evidence.
    expect(detail.contradictions).toEqual(['Elevated RSI', 'Broader tape looks choppy.']);
    expect(detail.aiReview).toEqual({ agreesWithSide: true, scenarioAnalysis: 'Real confluence with some risk.', disagreementNote: null });
    expect(detail.featureSnapshot).toBeNull();
  });

  it('reports supportingQuantDetail as null (never a fabricated structure) when no contributing agent was QuantEngine', async () => {
    agent.recentIdeas = buyPair('AAPL', 0.95);

    await agent.evaluateConsensus('AAPL', 't8');

    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.supportingQuantDetail).toBeNull();
  });

  it('does not approve when BearResearcher HOLD evidence is present even if two agents agree on BUY', async () => {
    agent.recentIdeas = [
      ...buyPair('AAPL', 0.95),
      {
        traceId: 't',
        symbol: 'AAPL',
        side: 'HOLD',
        confidence: bullBearResearchConfig.bearHoldMinConfidence,
        agent: bullBearResearchConfig.bearAgentName,
        reasoning: 'structured case against the trade',
      },
    ];

    await agent.evaluateConsensus('AAPL', 't-bear');

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('reviewIdea drops stray entry ideas when Autobot is off and does not call debate/LLM', async () => {
    ideaGenEnabled.value = false;
    routeTask.mockResolvedValue({ content: '{}' });
    await agent.reviewIdea({
      traceId: 't-off', symbol: 'AAPL', side: 'BUY', confidence: 0.95,
      agent: 'TechnicalAgent', reasoning: 'stray',
    });
    expect(routeTask).not.toHaveBeenCalled();
    expect(emitChiefApproval).not.toHaveBeenCalled();
    expect(agent.recentIdeas).toHaveLength(0);
  });

  it('reviewIdea still accepts PortfolioMonitor SELL risk-exits when Autobot is off', async () => {
    ideaGenEnabled.value = false;
    await agent.reviewIdea({
      traceId: 't-exit', symbol: 'AAPL', side: 'SELL', confidence: 0.9,
      agent: agentWeightConfig.riskExitAgent, reasoning: 'EXIT_CODE=stop',
    });
    expect(agent.recentIdeas.length).toBeGreaterThan(0);
  });

  // Real bug fixed: two evaluateConsensus() calls for the same symbol (e.g. two overlapping
  // risk-exit ideas) used to run fully independently/concurrently - both could read
  // this.recentIdeas and both approve before either finished. Now queued per-symbol, mirroring
  // RiskEngine.evaluateRisk()'s own promise-chain mutex. Proven deterministically by holding the
  // first call open with a manually-released gate and asserting the second call has not started
  // while the first is still in flight - no reliance on real timing races.
  it('serializes two concurrent evaluateConsensus calls for the same symbol - the second never starts before the first finishes', async () => {
    agent.recentIdeas = [...buyPair('AAPL', fixtures.strongAgreementConfidence)];
    const order: string[] = [];
    const realSerialized = agent.evaluateConsensusSerialized.bind(agent);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.spyOn(agent, 'evaluateConsensusSerialized').mockImplementation(async (symbol: string, traceId: string) => {
      order.push(`start:${traceId}`);
      if (traceId === 't1') await gate;
      await realSerialized(symbol, traceId);
      order.push(`end:${traceId}`);
    });

    const p1 = agent.evaluateConsensus('AAPL', 't1');
    const p2 = agent.evaluateConsensus('AAPL', 't2');
    await new Promise((r) => setTimeout(r, 0));
    // t2 must not have started yet - it's queued behind t1, which is still held open by the gate.
    expect(order).toEqual(['start:t1']);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start:t1', 'end:t1', 'start:t2', 'end:t2']);
  });

  it('real bug found and fixed: an idea arriving mid-evaluation (during the calibrateConfidence await) is not wiped when that evaluation approves', async () => {
    agent.recentIdeas = [...buyPair('AAPL', fixtures.strongAgreementConfidence)];
    let releaseCalibration!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCalibration = resolve; });
    let calibrationCalls = 0;
    const realCalibrate = agent.calibrateConfidence.bind(agent);
    // evaluateConsensusSerialized calibrates every relevant idea concurrently (Promise.all), so
    // both calls in this pair start together - gate all of them open until released below.
    vi.spyOn(agent, 'calibrateConfidence').mockImplementation(async (agentName: string, rawConfidence: number) => {
      calibrationCalls += 1;
      await gate;
      return realCalibrate(agentName, rawConfidence);
    });

    const evalPromise = agent.evaluateConsensus('AAPL', 'race-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(calibrationCalls).toBe(2); // evaluateConsensusSerialized is paused inside calibrateConfidence, for both ideas in the pair

    // A genuinely independent third agent's idea for the SAME symbol arrives while the above
    // evaluation is still mid-flight - exactly what reviewIdea()'s upsertIdea() does in production.
    const lateIdea = { traceId: 'late', symbol: 'AAPL', side: 'BUY', confidence: fixtures.strongAgreementConfidence, agent: 'KronosEngine', reasoning: 'late arrival' };
    agent.recentIdeas.push(lateIdea);

    releaseCalibration();
    await evalPromise;

    expect(emitChiefApproval).toHaveBeenCalledTimes(1); // the original pair still approved as expected
    // Before the fix, the approval branch wiped every recentIdeas row for AAPL, including this one
    // that arrived after the snapshot this evaluation actually considered - silently discarding a
    // real agent's vote before any future evaluation could ever see it.
    expect(agent.recentIdeas).toContain(lateIdea);
  });

  it('does not serialize two different symbols against each other', async () => {
    agent.recentIdeas = [...buyPair('AAPL', fixtures.strongAgreementConfidence), ...buyPair('MSFT', fixtures.strongAgreementConfidence)];
    const pAAPL = agent.evaluateConsensus('AAPL', 't-aapl');
    const pMSFT = agent.evaluateConsensus('MSFT', 't-msft');
    await Promise.all([pAAPL, pMSFT]);
    expect(emitChiefApproval).toHaveBeenCalledTimes(2);
  });

  it('does not treat duplicate TechnicalAgent BUY ticks as independent agreement with Kronos SELL', async () => {
    agent.recentIdeas = [
      ...Array.from({ length: 50 }, (_, i) => ({
        traceId: `tech-${i}`, symbol: 'QQQ', side: 'BUY', confidence: 0.9, agent: 'TechnicalAgent', reasoning: 'rsi',
      })),
      { traceId: 'k1', symbol: 'QQQ', side: 'SELL', confidence: 0.85, agent: 'KronosEngine', reasoning: 'reversal' },
    ];
    await agent.evaluateConsensus('QQQ', 'storm-1');
    expect(emitChiefApproval).not.toHaveBeenCalled();
    const outcome = agent.getLastConsensusOutcome();
    expect(outcome.approved).toBe(false);
    expect(outcome.independentAgreeingAgents).toBeLessThan(MIN_INDEPENDENT_AGREEING_AGENTS);
  });

  it('approves Technical BUY + Kronos BUY when weighted confidence clears the configured threshold', async () => {
    agent.recentIdeas = [
      { traceId: 't', symbol: 'SPY', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'tech' },
      { traceId: 't', symbol: 'SPY', side: 'BUY', confidence: 0.95, agent: 'KronosEngine', reasoning: 'kronos' },
    ];
    await agent.evaluateConsensus('SPY', 't-multi');
    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    expect(emitChiefApproval.mock.calls[0][0].side).toBe('BUY');
  });

  it('a 0-successCount debate is fail-closed HOLD even if consensus_verdict is a truthy HOLD string', async () => {
    routeConsensus.mockResolvedValue({
      consensus_verdict: 'HOLD',
      successCount: 0,
      results: [
        { status: 'error', provider: 'openai', error: 'timeout' },
        { status: 'error', provider: 'nvidia', error: '404' },
        { status: 'error', provider: 'gemini', error: 'fetch failed' },
      ],
    });
    await agent.reviewIdea({ traceId: 'z1', symbol: 'IWM', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong' });
    await agent.reviewIdea({ traceId: 'z1', symbol: 'IWM', side: 'BUY', confidence: 0.95, agent: 'KronosEngine', reasoning: 'confirm' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (agent.recentIdeas.some((i: any) => i.agent === 'ConsensusDebate' && String(i.reasoning).includes('fail-closed'))) break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect(emitChiefApproval).not.toHaveBeenCalled();
    const debate = agent.recentIdeas.find((i: any) => i.agent === 'ConsensusDebate');
    expect(debate.reasoning).not.toMatch(/Based on 3 models/i);
    expect(debate.debateTelemetry.providers_succeeded).toBe(0);
  });

  it('does not start a second routeConsensus while a debate is already in flight for that symbol', async () => {
    routeConsensus.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 8; i++) {
      await agent.reviewIdea({
        traceId: `storm-${i}`,
        symbol: 'DIA',
        side: 'BUY',
        confidence: 0.95,
        agent: 'TechnicalAgent',
        reasoning: 'repeat tick',
      });
    }
    expect(routeConsensus).toHaveBeenCalledTimes(1);
    expect(agent.recentIdeas.filter((i: any) => i.agent === 'TechnicalAgent' && i.symbol === 'DIA')).toHaveLength(1);
  });

  it('single-model debate text never claims a 3-model consensus', async () => {
    routeConsensus.mockResolvedValue({
      consensus_verdict: 'BUY',
      successCount: 1,
      results: [{ status: 'success', provider: 'gemini' }, { status: 'error', provider: 'nvidia', error: '404' }],
    });
    await agent.reviewIdea({ traceId: 's1', symbol: 'MSFT', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (agent.recentIdeas.some((i: any) => i.agent === 'ConsensusDebate' && i.side === 'BUY')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const debate = agent.recentIdeas.find((i: any) => i.agent === 'ConsensusDebate');
    expect(debate.reasoning).toMatch(/Based on 1 model/);
    expect(debate.reasoning).not.toMatch(/Based on 2 models|Based on 3 models/);
    expect(debate.debateTelemetry.providers_succeeded).toBe(1);
  });
});
