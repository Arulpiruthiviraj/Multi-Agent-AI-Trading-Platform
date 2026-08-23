import { describe, it, expect } from 'vitest';
import {
  isPipelineAgentHealthLabelHealthy,
  mapHealthLabelToVisualStatus,
  resolvePipelineAgentHealthLabel,
  type ResolvePipelineAgentHealthLabelInput,
} from './pipelineAgentHealthLabel';

function base(over: Partial<ResolvePipelineAgentHealthLabelInput> = {}): ResolvePipelineAgentHealthLabelInput {
  return {
    available: true,
    enabled: true,
    ideaWorkersArmed: true,
    keepsBackgroundPipeline: false,
    lastTickAt: null,
    alive: false,
    currentState: 'IDLE',
    consecutiveFailures: 0,
    autobotTickBusArmed: false,
    chronosAvailable: null,
    ...over,
  };
}

describe('resolvePipelineAgentHealthLabel', () => {
  it('maps ENV_OFF / OFFLINE / NOT_ARMED before operational states', () => {
    expect(resolvePipelineAgentHealthLabel(base({ available: false }))).toBe('ENV_OFF');
    expect(resolvePipelineAgentHealthLabel(base({ enabled: false }))).toBe('OFFLINE');
    expect(resolvePipelineAgentHealthLabel(base({
      ideaWorkersArmed: false,
      keepsBackgroundPipeline: false,
      lastTickAt: Date.now(),
      alive: true,
    }))).toBe('NOT_ARMED');
  });

  it('enabled+available+no MARKET_DATA yet (Autobot off) is IDLE_WAITING_FOR_MARKET_DATA, never FAILED', () => {
    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: null,
      alive: false,
      autobotTickBusArmed: false,
    }))).toBe('IDLE_WAITING_FOR_MARKET_DATA');

    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: Date.now() - 60_000,
      alive: false,
      autobotTickBusArmed: false,
      currentState: 'FAILED',
      consecutiveFailures: 5,
    }))).toBe('IDLE_WAITING_FOR_MARKET_DATA');
  });

  it('Kronos Chronos /health down is UNAVAILABLE even when armed', () => {
    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: Date.now(),
      alive: true,
      autobotTickBusArmed: true,
      chronosAvailable: false,
    }))).toBe('UNAVAILABLE');
  });

  it('Autobot on + stale heartbeat is FAILED; fresh tick is RUNNING/STARTING/DEGRADED', () => {
    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: Date.now() - 999_999,
      alive: false,
      autobotTickBusArmed: true,
    }))).toBe('FAILED');

    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: Date.now(),
      alive: true,
      autobotTickBusArmed: true,
      currentState: 'SUCCESS',
    }))).toBe('RUNNING');

    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: Date.now(),
      alive: true,
      autobotTickBusArmed: true,
      currentState: 'TICKING',
    }))).toBe('STARTING');

    expect(resolvePipelineAgentHealthLabel(base({
      lastTickAt: Date.now(),
      alive: true,
      autobotTickBusArmed: true,
      consecutiveFailures: 1,
      currentState: 'SUCCESS',
    }))).toBe('DEGRADED');
  });

  it('healthy lamp includes RUNNING/STARTING/DEGRADED/GATED only', () => {
    expect(isPipelineAgentHealthLabelHealthy('RUNNING')).toBe(true);
    expect(isPipelineAgentHealthLabelHealthy('STARTING')).toBe(true);
    expect(isPipelineAgentHealthLabelHealthy('DEGRADED')).toBe(true);
    expect(isPipelineAgentHealthLabelHealthy('GATED')).toBe(true);
    expect(isPipelineAgentHealthLabelHealthy('IDLE_WAITING_FOR_MARKET_DATA')).toBe(false);
    expect(isPipelineAgentHealthLabelHealthy('FAILED')).toBe(false);
    expect(isPipelineAgentHealthLabelHealthy('UNAVAILABLE')).toBe(false);
  });

  it('mapHealthLabelToVisualStatus preserves waiting ≠ FAIL', () => {
    expect(mapHealthLabelToVisualStatus('IDLE_WAITING_FOR_MARKET_DATA')).toBe('IDLE_WAITING_FOR_MARKET_DATA');
    expect(mapHealthLabelToVisualStatus('FAILED')).toBe('FAILED');
    expect(mapHealthLabelToVisualStatus('UNAVAILABLE')).toBe('UNAVAILABLE');
    expect(mapHealthLabelToVisualStatus('RUNNING')).toBe('RUNNING');
  });
});
