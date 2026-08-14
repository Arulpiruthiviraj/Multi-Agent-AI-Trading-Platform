import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepSeekProvider } from './DeepSeekProvider';

// Real test coverage for the Phase 6 hardening fix - identical shape to GeminiProvider.test.ts.
describe('DeepSeekProvider - model override (Phase 6 hardening)', () => {
  let provider: DeepSeekProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'response' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    } as any);
    provider = new DeepSeekProvider();
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
    await provider.chat('hello');
    expect(requestedModel()).toBe('deepseek-coder');
  });

  it('the exact bug this closes: a valid per-agent model override actually reaches the real API call', async () => {
    await provider.chat('hello', { model: 'deepseek-chat' });
    expect(requestedModel()).toBe('deepseek-chat');
  });

  it('rejects an unsupported model name rather than silently executing against it - falls back to the real default', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await provider.chat('hello', { model: 'deepseek-99-nonexistent' });
    expect(requestedModel()).toBe('deepseek-coder');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
