import { describe, it, expect } from 'vitest';
import { aiModels, isHeavyModel, isResearchAgentType } from './aiModels';

describe('aiModels.json research routing (2026-08-20 performance audit)', () => {
  it('exposes researchTimeoutMs = 8000 for Bull/Bear + consensus fail-fast', () => {
    expect(aiModels.researchTimeoutMs).toBe(8000);
  });

  it('routes BullResearcher and BearResearcher to Plutus (not deepseek-r1:14b heavy queue)', () => {
    expect(aiModels.routes.BullResearcher.model).toBe('0xroyce/plutus:latest');
    expect(aiModels.routes.BearResearcher.model).toBe('0xroyce/plutus:latest');
    expect(aiModels.routes.BullResearcher.fallback).toEqual(['llama3.2:latest']);
    expect(aiModels.routes.BearResearcher.fallback).toEqual(['llama3.2:latest']);
    expect(isHeavyModel(aiModels.routes.BullResearcher.model)).toBe(false);
    expect(isHeavyModel(aiModels.routes.BearResearcher.model)).toBe(false);
    expect(isResearchAgentType('BullResearcher')).toBe(true);
    expect(isResearchAgentType('BearResearcher')).toBe(true);
  });

  it('keeps ReflectionEngine on deepseek-r1:14b (heavy mutex still applies there)', () => {
    expect(aiModels.routes.ReflectionEngine.model).toBe('deepseek-r1:14b');
    expect(isHeavyModel(aiModels.routes.ReflectionEngine.model)).toBe(true);
    expect(isResearchAgentType('ReflectionEngine')).toBe(false);
  });

  it('exposes a positive maxResponseTokens cap applied to every provider call (2026-08-24 cost fix)', () => {
    expect(aiModels.maxResponseTokens).toBeGreaterThan(0);
    expect(Number.isInteger(aiModels.maxResponseTokens)).toBe(true);
  });

  it('routes QuantContradictionAnalyzer to Plutus so it stops defaulting to a paid provider (2026-08-24 cost fix - was 72% of that day\'s AI spend)', () => {
    expect(aiModels.routes.QuantContradictionAnalyzer.model).toBe('0xroyce/plutus:latest');
    expect(aiModels.routes.QuantContradictionAnalyzer.fallback).toEqual(['llama3.2:latest']);
    expect(isHeavyModel(aiModels.routes.QuantContradictionAnalyzer.model)).toBe(false);
  });
});
