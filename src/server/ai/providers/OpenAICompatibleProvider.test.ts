import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider, stripThinkTags } from './OpenAICompatibleProvider';

describe('stripThinkTags - real bug fix: DeepSeek R1 reasoning blocks polluted downstream JSON parsing', () => {
  it('removes a real <think>...</think> block and trims surrounding whitespace', () => {
    const raw = '<think>\nLet me reason about this trade...\nOkay, I have decided.\n</think>\n{"decision":"HOLD","confidence":40}';
    expect(stripThinkTags(raw)).toBe('{"decision":"HOLD","confidence":40}');
  });

  it('is a no-op when there is no think block (non-reasoning models unaffected)', () => {
    expect(stripThinkTags('{"decision":"BUY","confidence":80}')).toBe('{"decision":"BUY","confidence":80}');
  });

  it('handles multiple think blocks and multiline content inside them', () => {
    const raw = '<think>first pass</think>middle<think>second\npass</think>final answer';
    expect(stripThinkTags(raw)).toBe('middlefinal answer');
  });
});

describe('OpenAICompatibleProvider - real same-provider model fallback + keep_alive', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function okResponse(content: string) {
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    };
  }

  it('CRITICAL: falls back to the next model on the SAME provider when the primary model fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' }) // primary model fails
      .mockResolvedValueOnce(okResponse('{"ok":true}')); // fallback model succeeds

    const provider = new OpenAICompatibleProvider('Ollama (Local)', 'http://127.0.0.1:11434/v1', true);
    await provider.initialize('', 'fingpt:latest');

    const result = await provider.chat('prompt', { model: 'fingpt:latest', fallbackModels: ['0xroyce/plutus:latest'] });
    expect(result.content).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.model).toBe('fingpt:latest');
    expect(secondBody.model).toBe('0xroyce/plutus:latest');
  });

  it('CRITICAL: each fallback model gets its OWN fresh timeout, not a shared remainder from the primary model (real bug found live in production)', async () => {
    // Primary model hangs until its own real AbortSignal fires (simulates a genuinely
    // cold-starting/contended local model) - with the OLD shared-deadline bug, the SAME signal
    // would already be aborted by the time the fallback ran, so the fallback would fail instantly
    // rather than getting a real, fresh attempt.
    let callIndex = 0;
    fetchMock.mockImplementation((_url: string, init: any) => {
      callIndex++;
      if (callIndex === 1) {
        // Real fetch() semantics: reject with an AbortError once the passed signal fires.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err: any = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return Promise.resolve(okResponse('{"ok":true}'));
    });

    const provider = new OpenAICompatibleProvider('Ollama (Local)', 'http://127.0.0.1:11434/v1', true);
    await provider.initialize('', 'fingpt:latest');

    const result = await provider.chat('prompt', {
      model: 'fingpt:latest',
      fallbackModels: ['0xroyce/plutus:latest'],
      timeoutMs: 50, // short, real per-model budget
    });
    expect(result.content).toBe('{"ok":true}');
    expect(callIndex).toBe(2); // primary attempted, then fallback attempted with a fresh signal
  }, 2000);

  it('throws the last real error when every model (primary + all fallbacks) fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
    const provider = new OpenAICompatibleProvider('Ollama (Local)', 'http://127.0.0.1:11434/v1', true);
    await provider.initialize('', 'fingpt:latest');
    await expect(provider.chat('prompt', { model: 'fingpt:latest', fallbackModels: ['0xroyce/plutus:latest'] })).rejects.toThrow();
  });

  it('automatically strips a real DeepSeek-style think block from the returned content', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<think>reasoning here</think>{"decision":"HOLD"}'));
    const provider = new OpenAICompatibleProvider('Ollama (Local)', 'http://127.0.0.1:11434/v1', true);
    await provider.initialize('', 'deepseek-r1:14b');
    const result = await provider.chat('prompt', { model: 'deepseek-r1:14b' });
    expect(result.content).toBe('{"decision":"HOLD"}');
  });

  it('includes keep_alive in the request body for a local provider, not for a remote one', async () => {
    fetchMock.mockResolvedValue(okResponse('ok'));

    const local = new OpenAICompatibleProvider('Ollama (Local)', 'http://127.0.0.1:11434/v1', true);
    await local.initialize('', 'llama3.2:latest');
    await local.chat('prompt', { model: 'llama3.2:latest' });
    const localBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(localBody.keep_alive).toBeTruthy();

    fetchMock.mockClear();
    const remote = new OpenAICompatibleProvider('OpenRouter', 'https://openrouter.ai/api/v1', false);
    await remote.initialize('sk-test', 'some-model');
    await remote.chat('prompt', { model: 'some-model' });
    const remoteBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(remoteBody.keep_alive).toBeUndefined();
  });
});
