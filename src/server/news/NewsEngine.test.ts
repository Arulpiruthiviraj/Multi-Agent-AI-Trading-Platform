import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newsEngine } from './NewsEngine';
import { getPipelineAgentHeartbeat, resetPipelineAgentHealthForTests } from '../core/pipelineAgentHealth';

describe('NewsEngine - pipeline health telemetry (ARGUS_PHASE2_FORENSIC_AUDIT.md #3)', () => {
  beforeEach(() => {
    resetPipelineAgentHealthForTests();
  });

  it('records lastSuccessfulTickAt after a cycle completes, even with zero fetched articles', async () => {
    vi.spyOn(newsEngine.providerManager, 'fetchAllLatest').mockResolvedValue([]);
    await (newsEngine as unknown as { runPipeline(): Promise<void> }).runPipeline();
    const heartbeat = getPipelineAgentHeartbeat('NewsAgent');
    expect(heartbeat.lastSuccessfulTickAt).not.toBeNull();
    expect(heartbeat.currentState).toBe('SUCCESS');
  });

  it('still records lastSuccessfulTickAt when news ideas are disabled (CATALYST_ONLY / Autobot off)', async () => {
    // Ideas-off must not look like a dead NewsAgent: clustering/analysis success is real success.
    vi.spyOn(newsEngine.providerManager, 'fetchAllLatest').mockResolvedValue([]);
    await (newsEngine as unknown as { runPipeline(): Promise<void> }).runPipeline();
    const heartbeat = getPipelineAgentHeartbeat('NewsAgent');
    expect(heartbeat.lastSuccessfulTickAt).not.toBeNull();
    expect(heartbeat.currentState).toBe('SUCCESS');
  });

  it('does not record success when the provider fetch throws', async () => {
    vi.spyOn(newsEngine.providerManager, 'fetchAllLatest').mockRejectedValue(new Error('providers down'));
    await (newsEngine as unknown as { runPipeline(): Promise<void> }).runPipeline();
    const heartbeat = getPipelineAgentHeartbeat('NewsAgent');
    expect(heartbeat.lastSuccessfulTickAt).toBeNull();
    expect(heartbeat.currentState).toBe('FAILED');
  });
});
