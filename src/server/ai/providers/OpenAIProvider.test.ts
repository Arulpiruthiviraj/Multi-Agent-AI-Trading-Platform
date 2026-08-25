import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from './OpenAIProvider';

// Real test coverage for the Phase 6 hardening fix - identical shape to GeminiProvider.test.ts.
describe('OpenAIProvider - model override (Phase 6 hardening)', () => {
  let provider: OpenAIProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'response' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    } as any);
    provider = new OpenAIProvider();
    await provider.initialize('test-key');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function requestedModel(): string {
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    return body.model;
  }

  it('uses the real default model when no override is requested (existing behavior preserved)', async () => {
    // Real cost fix (2026-08-24): default switched gpt-4o -> gpt-4o-mini - see OpenAIProvider.ts's
    // own comment. Every Argus call here is a short structured-JSON classification, not a task that
    // needed the larger model.
    await provider.chat('hello');
    expect(requestedModel()).toBe('gpt-4o-mini');
  });

  it('the exact bug this closes: a valid per-agent model override actually reaches the real API call', async () => {
    await provider.chat('hello', { model: 'gpt-4o' });
    expect(requestedModel()).toBe('gpt-4o');
  });

  it('rejects an unsupported model name rather than silently executing against it - falls back to the real default', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await provider.chat('hello', { model: 'gpt-99-nonexistent' });
    expect(requestedModel()).toBe('gpt-4o-mini');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Phase 7 (AI_MODEL_INVENTORY.md)
  it('passes a caller-supplied temperature through to the real API call when provided', async () => {
    await provider.chat('hello', { temperature: 0.2 });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    expect(body.temperature).toBe(0.2);
  });

  it('omits temperature entirely when the caller does not supply one - no behavior change for existing callers', async () => {
    await provider.chat('hello');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    expect(body).not.toHaveProperty('temperature');
  });
});
