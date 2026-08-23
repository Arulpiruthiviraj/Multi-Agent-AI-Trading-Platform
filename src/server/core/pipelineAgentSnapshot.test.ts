import { describe, it, expect, afterEach, vi } from 'vitest';
import { getPipelineAgentSnapshot } from './pipelineAgentSnapshot';
import { setIdeaWorkersArmed, areIdeaWorkersArmed } from './pipelineAgentRuntime';
import { pipelineAgentsConfig } from '../config/pipelineAgents';
import { resetPipelineAgentHealthForTests } from './pipelineAgentHealth';
import { tradingEngine } from '../engines/TradingEngine';

/**
 * Real bug found and fixed this pass: `healthy` used to be computed independently of
 * `healthLabel` (enabled && available && alive, never checking ideaWorkersArmed), so right after
 * the idea-worker runtimes were disarmed, a togglable agent could report healthy:true and
 * healthLabel:'NOT_ARMED' on the same response row - an internally inconsistent API contract on
 * GET /api/v1/system/pipeline-agents.
 *
 * Follow-up (2026-08-21): enabled+available+no ticks+Autobot off must be
 * IDLE_WAITING_FOR_MARKET_DATA, never DEAD/FAILED.
 */
describe('getPipelineAgentSnapshot(): healthy and healthLabel never disagree', () => {
  const originalArmed = areIdeaWorkersArmed();
  const originalEnabled = tradingEngine.state.enabled;
  const originalTradingState = tradingEngine.state.tradingState;

  afterEach(() => {
    setIdeaWorkersArmed(originalArmed);
    tradingEngine.state.enabled = originalEnabled;
    tradingEngine.state.tradingState = originalTradingState;
    resetPipelineAgentHealthForTests();
    vi.restoreAllMocks();
  });

  it('healthy is false whenever healthLabel is not a healthy lamp label, for every togglable agent', () => {
    setIdeaWorkersArmed(false);
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const snapshot = getPipelineAgentSnapshot();
    for (const row of snapshot.togglable) {
      if (row.healthLabel === 'RUNNING' || row.healthLabel === 'GATED' || row.healthLabel === 'DEGRADED' || row.healthLabel === 'STARTING') {
        expect(row.healthy).toBe(true);
      } else {
        expect(row.healthy).toBe(false);
      }
    }
  });

  it('specifically: a background-pipeline-exempt agent disarmed still reports healthy:false when its label is NOT_ARMED', () => {
    setIdeaWorkersArmed(false);
    const snapshot = getPipelineAgentSnapshot();
    const nonBackgroundAgent = pipelineAgentsConfig.togglableIdeaAgents.find((a) => a.keepsBackgroundPipeline !== true);
    expect(nonBackgroundAgent).toBeDefined();
    const row = snapshot.togglable.find((r) => r.id === nonBackgroundAgent!.id)!;
    if (row.available && row.enabled) {
      expect(row.healthLabel).toBe('NOT_ARMED');
      expect(row.healthy).toBe(false);
    }
  });

  it('background Kronos/News with Autobot off and no ticks → IDLE_WAITING_FOR_MARKET_DATA (not FAILED/DEAD)', () => {
    setIdeaWorkersArmed(false);
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    resetPipelineAgentHealthForTests();
    const snapshot = getPipelineAgentSnapshot();
    const background = snapshot.togglable.filter((r) => r.keepsBackgroundPipeline === true && r.available && r.enabled);
    expect(background.length).toBeGreaterThan(0);
    for (const row of background) {
      // Chronos may flip Kronos to UNAVAILABLE; that is still not DEAD/FAILED-from-waiting.
      if (row.id === 'KronosEngine' && row.chronosAvailable === false) {
        expect(row.healthLabel).toBe('UNAVAILABLE');
      } else {
        expect(row.healthLabel).toBe('IDLE_WAITING_FOR_MARKET_DATA');
      }
      expect(row.healthLabel).not.toBe('FAILED');
      expect(String(row.healthLabel)).not.toBe('DEAD');
      expect(row.healthy).toBe(false);
    }
  });
});
