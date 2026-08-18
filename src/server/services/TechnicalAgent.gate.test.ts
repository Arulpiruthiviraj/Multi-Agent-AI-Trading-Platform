import { describe, it, expect, afterEach, vi } from 'vitest';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled, setPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { pipelineAgentsConfig } from '../config/pipelineAgents';
import { tradingEngine } from '../engines/TradingEngine';
import { technicalAgent } from './TechnicalAgent';
import { eventBus } from '../core/EventBus';
import { quantThresholds } from '../config/quantThresholds';

const technicalId = pipelineAgentsConfig.togglableIdeaAgents.find((a) => a.label === 'Technical')!.id;

describe('idea generation start gate', () => {
  const originalEnabled = tradingEngine.state.enabled;
  const originalTradingState = tradingEngine.state.tradingState;

  afterEach(() => {
    tradingEngine.state.enabled = originalEnabled;
    tradingEngine.state.tradingState = originalTradingState;
    setPipelineAgentEnabled(technicalId, true);
    delete (technicalAgent as any).priceHistory['GATE_TEST_XYZ'];
    delete (technicalAgent as any).lastEvaluatedAt['GATE_TEST_XYZ'];
  });

  it('is closed when Autobot is off even if tradingState is TRADING_ENABLED', () => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('is closed when tradingState is TRADING_PAUSED even if Autobot is on', () => {
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('TechnicalAgent ignores Autobot-off ticks (no price-history warmup)', () => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    technicalAgent.analyzeTick({ symbol: 'GATE_TEST_XYZ', price: 10, volume: 1, timestamp: new Date().toISOString() });
    expect((technicalAgent as any).priceHistory['GATE_TEST_XYZ']).toBeUndefined();
  });

  it('toggling TechnicalAgent off prevents TRADE_IDEA_GENERATED while Autobot is on', () => {
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    expect(isLiveIdeaGenerationEnabled()).toBe(true);
    expect(setPipelineAgentEnabled(technicalId, false).ok).toBe(true);
    expect(isPipelineAgentEnabled(technicalId)).toBe(false);

    const spy = vi.spyOn(eventBus, 'emitTradeIdea');
    technicalAgent.analyzeTick({ symbol: 'GATE_TEST_XYZ', price: 10, volume: 1, timestamp: new Date().toISOString() });
    expect(spy).not.toHaveBeenCalled();
    expect((technicalAgent as any).priceHistory['GATE_TEST_XYZ']).toBeUndefined();
    spy.mockRestore();
  });

  it('does not re-run checkStrategies on every tick once warmed up - only after the cooldown elapses (2026-08-18 runaway-loop fix)', () => {
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const spy = vi.spyOn(technicalAgent as any, 'checkStrategies');

    // Warm up exactly to technicalHistoryBars ticks - the first tick at that length evaluates.
    for (let i = 0; i < quantThresholds.technicalHistoryBars; i++) {
      technicalAgent.analyzeTick({ symbol: 'GATE_TEST_XYZ', price: 100 + i, volume: 1, timestamp: new Date().toISOString() });
    }
    expect(spy).toHaveBeenCalledTimes(1);

    // Real bug: history.length stays === technicalHistoryBars forever (capped by shift()), so
    // every one of these used to also call checkStrategies before the cooldown existed.
    for (let i = 0; i < 20; i++) {
      technicalAgent.analyzeTick({ symbol: 'GATE_TEST_XYZ', price: 101, volume: 1, timestamp: new Date().toISOString() });
    }
    expect(spy).toHaveBeenCalledTimes(1);

    // Once the cooldown has genuinely elapsed, evaluation resumes.
    (technicalAgent as any).lastEvaluatedAt['GATE_TEST_XYZ'] = Date.now() - quantThresholds.technicalEvaluationCooldownMs - 1;
    technicalAgent.analyzeTick({ symbol: 'GATE_TEST_XYZ', price: 102, volume: 1, timestamp: new Date().toISOString() });
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });
});
