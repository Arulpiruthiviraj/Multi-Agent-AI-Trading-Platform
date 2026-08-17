import { describe, it, expect } from 'vitest';
import { buildProviderInventory } from './configRoutes';

describe('buildProviderInventory', () => {
  it('includes known catalog providers that have no ai_providers row as not_configured', () => {
    const inventory = buildProviderInventory([]);
    const deepseek = inventory.find((p) => p.providerName === 'DeepSeek');
    expect(deepseek).toBeTruthy();
    expect(deepseek!.usageStatus).toBe('not_configured');
    expect(deepseek!.metricsAvailable).toBe(false);
    expect(deepseek!.displayHealth).toBeNull();
    expect(deepseek!.inDatabase).toBe(false);
  });

  it('marks enabled local endpoints active without requiring a key', () => {
    const inventory = buildProviderInventory([
      {
        id: 'ollama-1',
        providerName: 'Ollama (Local)',
        displayName: 'Ollama',
        apiEndpoint: 'http://localhost:11434/v1',
        apiKeyEncrypted: null,
        defaultModel: null,
        enabled: true,
        priority: 4,
        active: true,
        health: 'Healthy',
        latency: 0,
        quota: 0,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successRate: 100,
        lastFailure: null,
        lastSuccess: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const ollama = inventory.find((p) => p.providerName === 'Ollama (Local)');
    expect(ollama!.usageStatus).toBe('active');
    expect(ollama!.metricsAvailable).toBe(false);
    expect(ollama!.latencyAvailable).toBe(false);
  });

  it('does not treat schema-default 0ms Healthy as real metrics when never called', () => {
    const inventory = buildProviderInventory([
      {
        id: 'gemini-1',
        providerName: 'Gemini',
        displayName: 'Gemini',
        apiEndpoint: null,
        apiKeyEncrypted: 'cipher',
        defaultModel: null,
        enabled: true,
        priority: 0,
        active: true,
        health: 'Healthy',
        latency: 0,
        quota: 0,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successRate: 100,
        lastFailure: null,
        lastSuccess: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const gemini = inventory.find((p) => p.providerName === 'Gemini');
    expect(gemini!.usageStatus).toBe('active');
    expect(gemini!.hasCredentials).toBe(true);
    expect(gemini!.displayHealth).toBeNull();
    expect(gemini!.metricsAvailable).toBe(false);
  });

  it('overrides Healthy stamp when rolling success rate is degraded', () => {
    const inventory = buildProviderInventory([
      {
        id: 'ollama-2',
        providerName: 'Ollama (Local)',
        displayName: 'Ollama',
        apiEndpoint: 'http://127.0.0.1:11434/v1',
        apiKeyEncrypted: null,
        defaultModel: null,
        enabled: true,
        priority: 4,
        active: true,
        health: 'Healthy',
        latency: 14698,
        quota: 0,
        requests: 10,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successRate: 45,
        lastFailure: '2026-01-01T00:00:00.000Z',
        lastSuccess: '2026-01-01T00:01:00.000Z',
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const ollama = inventory.find((p) => p.providerName === 'Ollama (Local)');
    expect(ollama!.displayHealth).toBe('Offline');
    expect(ollama!.metricsAvailable).toBe(true);
    expect(ollama!.latencyAvailable).toBe(true);
    expect(ollama!.healthNote).toMatch(/rolling success rate/i);
  });

  it('never returns apiKeyEncrypted ciphertext in the inventory payload', () => {
    const inventory = buildProviderInventory([
      {
        id: 'openai-1',
        providerName: 'OpenAI',
        displayName: 'OpenAI',
        apiEndpoint: null,
        apiKeyEncrypted: 'should-not-leak',
        defaultModel: null,
        enabled: true,
        priority: 1,
        active: true,
        health: 'Degraded',
        latency: 0,
        quota: 0,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successRate: 100,
        lastFailure: '2026-01-01T00:00:00.000Z',
        lastSuccess: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const openai = inventory.find((p) => p.providerName === 'OpenAI');
    expect(openai!.apiKeyEncrypted).toBeUndefined();
    expect(openai!.latencyAvailable).toBe(false);
  });
});
