import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from './AnthropicProvider';

// Real test coverage for the 2026-08-24 readiness audit, Part 4: Claude previously had no
// dedicated provider - this class implements the real Anthropic Messages API (x-api-key header,
// anthropic-version header, typed content-block array response), not the OpenAI-compatible schema
// the rest of AIRouter's generic branch speaks.
describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function mockOkResponse(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 2 },
        stop_reason: 'end_turn',
        ...overrides,
      }),
    } as any;
  }

  beforeEach(async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockOkResponse());
    provider = new AnthropicProvider();
    await provider.initialize('test-anthropic-key');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function lastRequest(): { url: string; headers: Record<string, string>; body: any } {
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
  }

  it('is not authenticated until a key is provided', async () => {
    const fresh = new AnthropicProvider();
    expect(await fresh.authenticate()).toBe(false);
    await fresh.initialize('a-key');
    expect(await fresh.authenticate()).toBe(true);
  });

  it('falls back to process.env.ANTHROPIC_API_KEY when no explicit key is passed', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    try {
      const fresh = new AnthropicProvider();
      await fresh.initialize();
      expect(await fresh.authenticate()).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('calls the real Anthropic Messages API with the correct headers, not an OpenAI-style Authorization header', async () => {
    await provider.chat('hello');
    const { url, headers, body } = lastRequest();

    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('test-anthropic-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('always sets max_tokens - Anthropic requires it on every request, unlike OpenAI', async () => {
    await provider.chat('hello');
    const { body } = lastRequest();
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('uses the real default model when no override is requested', async () => {
    await provider.chat('hello');
    const { body } = lastRequest();
    expect(body.model).toBe('claude-haiku-4-5-20251001');
  });

  it('a valid per-agent model override reaches the real API call', async () => {
    await provider.chat('hello', { model: 'claude-sonnet-5' });
    const { body } = lastRequest();
    expect(body.model).toBe('claude-sonnet-5');
  });

  it('rejects an unsupported model name rather than silently executing against it - falls back to the real default', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await provider.chat('hello', { model: 'claude-99-nonexistent' });
    const { body } = lastRequest();
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('parses the real content-block array response, joining only text blocks', async () => {
    fetchSpy.mockResolvedValue(mockOkResponse({ content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }] }));
    const result = await provider.chat('hello');
    expect(result.content).toBe('first second');
  });

  it('skips non-text blocks (e.g. a thinking block preceding the real text block) rather than concatenating them into the answer', async () => {
    fetchSpy.mockResolvedValue(mockOkResponse({ content: [{ type: 'thinking', text: 'internal reasoning' }, { type: 'text', text: 'final answer' }] }));
    const result = await provider.chat('hello');
    expect(result.content).toBe('final answer');
  });

  it('reports real input/output token usage from the response, not a hardcoded value', async () => {
    fetchSpy.mockResolvedValue(mockOkResponse({ usage: { input_tokens: 123, output_tokens: 45 } }));
    const result = await provider.chat('hello');
    expect(result.inputTokens).toBe(123);
    expect(result.outputTokens).toBe(45);
    expect(result.tokens).toBe(168);
  });

  it('throws a real, classifiable error (status + body snippet) on a non-2xx response, never a fabricated success', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    } as any);

    await expect(provider.chat('hello')).rejects.toThrow(/Claude API error: 401 Unauthorized.*authentication_error/);
  });

  it('throws when chat() is called with no credential configured, rather than sending an unauthenticated request', async () => {
    const fresh = new AnthropicProvider();
    await expect(fresh.chat('hello')).rejects.toThrow(/not authenticated/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
