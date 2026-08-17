import { describe, it, expect, afterEach } from 'vitest';
import { pipelineAgentsConfig } from '../config/pipelineAgents';
import {
  isPipelineAgentEnabled,
  setPipelineAgentEnabled,
  setAllTogglableIdeaAgents,
} from './pipelineAgentGate';

const technicalId = pipelineAgentsConfig.togglableIdeaAgents.find((a) => a.label === 'Technical')!.id;
const riskId = pipelineAgentsConfig.alwaysOn.find((a) => a.label === 'Risk Engine')!.id;
const omsId = pipelineAgentsConfig.alwaysOn.find((a) => a.label === 'Order Management')!.id;

describe('pipelineAgentGate', () => {
  afterEach(() => {
    setPipelineAgentEnabled(technicalId, true);
  });

  it('defaults togglable idea agents to enabled', () => {
    expect(isPipelineAgentEnabled(technicalId)).toBe(true);
  });

  it('refuses to disable RiskEngine / OMS / kill-switch ids', () => {
    expect(setPipelineAgentEnabled(riskId, false).ok).toBe(false);
    expect(isPipelineAgentEnabled(riskId)).toBe(true);
    expect(setPipelineAgentEnabled(omsId, false).ok).toBe(false);
    expect(setPipelineAgentEnabled('emergency-stop', false).ok).toBe(false);
    expect(setPipelineAgentEnabled('RiskAgent', false).ok).toBe(false);
  });

  it('can disable a togglable idea agent without touching Autobot', () => {
    const result = setPipelineAgentEnabled(technicalId, false);
    expect(result.ok).toBe(true);
    expect(isPipelineAgentEnabled(technicalId)).toBe(false);
  });

  it('DISABLE ALL ideas turns togglable agents off and ENABLE ALL turns them on', () => {
    expect(setAllTogglableIdeaAgents(false).ok).toBe(true);
    expect(isPipelineAgentEnabled(technicalId)).toBe(false);
    expect(setAllTogglableIdeaAgents(true).ok).toBe(true);
    expect(isPipelineAgentEnabled(technicalId)).toBe(true);
    expect(isPipelineAgentEnabled(riskId)).toBe(true);
  });
});
