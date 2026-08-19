import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPipelineAgentHeartbeat,
  isPipelineAgentAlive,
  notePipelineAgentFailure,
  notePipelineAgentSuccess,
  notePipelineAgentTick,
  resetPipelineAgentHealthForTests,
} from './pipelineAgentHealth';
import { tradingSafety } from '../config/tradingSafety';

describe('pipelineAgentHealth', () => {
  beforeEach(() => resetPipelineAgentHealthForTests());

  it('treats a fresh tick as alive and distinguishes success from failure', () => {
    notePipelineAgentTick('FundamentalAgent');
    notePipelineAgentSuccess('FundamentalAgent');
    const row = getPipelineAgentHeartbeat('FundamentalAgent');
    expect(isPipelineAgentAlive('FundamentalAgent')).toBe(true);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.currentState).toBe('SUCCESS');

    notePipelineAgentFailure('FundamentalAgent', new Error('timeout'));
    const failed = getPipelineAgentHeartbeat('FundamentalAgent');
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.lastError).toContain('timeout');
    expect(failed.currentState).toBe('FAILED');
  });

  it('a tick older than pipelineAgentDeadAfterMs is not alive', () => {
    notePipelineAgentTick('MacroAgent');
    const row = getPipelineAgentHeartbeat('MacroAgent');
    expect(row.lastTickAt).not.toBeNull();
    expect(isPipelineAgentAlive('MacroAgent', row.lastTickAt! + tradingSafety.pipelineAgentDeadAfterMs + 1)).toBe(false);
  });
});
