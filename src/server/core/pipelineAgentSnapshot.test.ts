import { describe, it, expect, afterEach } from 'vitest';
import { getPipelineAgentSnapshot } from './pipelineAgentSnapshot';
import { setIdeaWorkersArmed, areIdeaWorkersArmed } from './pipelineAgentRuntime';
import { pipelineAgentsConfig } from '../config/pipelineAgents';

/**
 * Real bug found and fixed this pass: `healthy` used to be computed independently of
 * `healthLabel` (enabled && available && alive, never checking ideaWorkersArmed), so right after
 * the idea-worker runtimes were disarmed, a togglable agent could report healthy:true and
 * healthLabel:'NOT_ARMED' on the same response row - an internally inconsistent API contract on
 * GET /api/v1/system/pipeline-agents.
 */
describe('getPipelineAgentSnapshot(): healthy and healthLabel never disagree', () => {
  const originalArmed = areIdeaWorkersArmed();

  afterEach(() => {
    setIdeaWorkersArmed(originalArmed);
  });

  it('healthy is false whenever healthLabel is not HEALTHY, for every togglable agent', () => {
    setIdeaWorkersArmed(false);
    const snapshot = getPipelineAgentSnapshot();
    for (const row of snapshot.togglable) {
      if (row.healthLabel === 'HEALTHY') {
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
});
