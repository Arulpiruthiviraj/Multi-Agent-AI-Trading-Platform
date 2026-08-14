import { describe, it, expect, vi, beforeEach } from 'vitest';

const { routeTask } = vi.hoisted(() => ({ routeTask: vi.fn() }));
vi.mock('../../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeTask }) } }));

import { analyzeContradictions, ContradictionAnalysisInput } from './QuantContradictionAnalyzer';

function baseInput(overrides: Partial<ContradictionAnalysisInput> = {}): ContradictionAnalysisInput {
  return {
    symbol: 'NVDA',
    side: 'BUY',
    regime: { regime: 'BULLISH_TREND', trendStrength: 80, volatility: 'NORMAL', marketStructure: 'TRENDING', confidence: 0.85, features: {} as any, insufficientData: false },
    strategyEvaluation: {
      strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', setupScore: 90, confidence: 0.9,
      conditionsMet: ['a', 'b'], conditionsFailed: [], contradictions: [],
      invalidationConditions: [], stop: { price: 100, basis: 'test' }, target: { price: 120, basis: 'test' },
      applicableRegimes: ['BULLISH_TREND'],
    },
    groupedScores: {
      trendScore: 85, momentumScore: 80, volatilityScore: 50, volumeScore: 75, vwapScore: 70,
      marketScore: 65, sectorScore: 70, relativeStrengthScore: 75, priceStructureScore: 80,
      overallSetupScore: 78, dataCompletePct: 90,
    },
    ...overrides,
  };
}

describe('analyzeContradictions', () => {
  beforeEach(() => routeTask.mockClear());

  it('returns a real AGREES verdict, never modifying the deterministic side/scores it was given', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ assessment: 'AGREES', additionalContradictions: [], scenarioAnalysis: 'Strong confluence.' }),
      aiCallId: 'c1', provider: 'gemini', latency: 100,
    });

    const input = baseInput();
    const result = await analyzeContradictions(input, 't1');

    expect(result.available).toBe(true);
    expect(result.aiAgreesWithSide).toBe(true);
    expect(result.disagreementNote).toBeNull();
    // The input object itself is untouched - this module never mutates or overwrites it.
    expect(input.side).toBe('BUY');
    expect(input.groupedScores.overallSetupScore).toBe(78);
  });

  it('records a real disagreement without ever flipping the deterministic side', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ assessment: 'DISAGREES', additionalContradictions: ['Macro headwinds not captured by these features.'], scenarioAnalysis: 'Risk of a broader pullback.', disagreementReason: 'Broader market context outweighs the local setup.' }),
      aiCallId: 'c2', provider: 'gemini', latency: 100,
    });

    const result = await analyzeContradictions(baseInput(), 't2');

    expect(result.aiAgreesWithSide).toBe(false);
    expect(result.disagreementNote).toBe('Broader market context outweighs the local setup.');
    expect(result.additionalContradictions).toContain('Macro headwinds not captured by these features.');
  });

  it('reports UNCERTAIN as a real null read, not forced into agree/disagree', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ assessment: 'UNCERTAIN', scenarioAnalysis: 'Mixed signals.' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    const result = await analyzeContradictions(baseInput(), 't3');
    expect(result.aiAgreesWithSide).toBeNull();
    expect(result.disagreementNote).toBeNull();
  });

  it('coerces an off-schema assessment value to UNCERTAIN rather than fabricating a verdict', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ assessment: 'PROBABLY', scenarioAnalysis: 'x' }), aiCallId: 'c4', provider: 'gemini', latency: 100 });

    const result = await analyzeContradictions(baseInput(), 't4');
    expect(result.aiAgreesWithSide).toBeNull();
  });

  it('degrades honestly (available:false) rather than throwing when the AI response is malformed (e.g. no provider actually reachable)', async () => {
    // A missing/undefined `content` is what a real AIRouter failure resolves to in some provider
    // error paths - this exercises the same catch-and-degrade branch as a rejected routeTask()
    // call would, without depending on how a rejected mock promise interacts with the test runner.
    routeTask.mockResolvedValue({ content: undefined, aiCallId: 'c5', provider: 'gemini', latency: 100 });

    const result = await analyzeContradictions(baseInput(), 't5');
    expect(result.available).toBe(false);
    expect(result.aiAgreesWithSide).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it('degrades honestly when the AI response is not valid JSON', async () => {
    routeTask.mockResolvedValue({ content: 'not json at all', aiCallId: 'c6', provider: 'gemini', latency: 100 });

    const result = await analyzeContradictions(baseInput(), 't6');
    expect(result.available).toBe(false);
  });

  it('builds a prompt that includes the real regime-only fallback framing when no strategy cleared its bar', async () => {
    let capturedPrompt = '';
    routeTask.mockImplementation(async (_agent: string, prompt: string) => {
      capturedPrompt = prompt;
      return { content: JSON.stringify({ assessment: 'UNCERTAIN', scenarioAnalysis: 'x' }), aiCallId: 'c7', provider: 'gemini', latency: 100 };
    });

    await analyzeContradictions(baseInput({ strategyEvaluation: null }), 't7');

    expect(routeTask).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toContain('regime-derived only');
  });
});
