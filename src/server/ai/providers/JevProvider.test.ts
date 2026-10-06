/**
 * JevProvider — research spike tests (mocked HTTP, no network, no API key).
 * Proves: wire-format parsing per question type, fail-closed answer validation
 * (never synthesizes a probability), retry semantics, and that the chat-centric
 * surface refuses to pretend Jev generates text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JevProvider, JevAnswerValidationError, JEV_INPUT_USD_PER_MILLION_TOKENS } from './JevProvider';

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

function mockFetchOnce(response: { ok: boolean; status: number; statusText?: string; json?: unknown; text?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? '',
    json: async () => response.json,
    text: async () => response.text ?? '',
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('JevProvider (research spike)', () => {
  let provider: JevProvider;

  beforeEach(() => {
    provider = new JevProvider();
    return provider.initialize('test-jev-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('authenticates on key presence, fails closed without one', async () => {
    expect(await provider.authenticate()).toBe(true);
    const noKey = new JevProvider();
    await noKey.initialize('');
    expect(await noKey.authenticate()).toBe(false);
  });

  it('posts to /v1/systemone with Bearer auth and parses a noul answer', async () => {
    const fetchMock = mockFetchOnce({
      ok: true, status: 200,
      json: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.83 } }, usage: { input_tokens: 392, output_tokens: 0 } },
    });
    const result = await provider.askYesNo('earnings beat, raised guidance', 'Is this news bullish for the stock?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SYSTEMONE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-jev-key');
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe('jev-latest');
    expect(sent.questions.q).toEqual({ type: 'noul', instructions: 'Is this news bullish for the stock?' });

    expect(result.probabilityYes).toBe(0.83);
    expect(result.model).toBe('jev-1.13.0'); // actual model, not the alias
    expect(result.inputTokens).toBe(392);
  });

  it('parses choice answers with probabilities and confidence', async () => {
    mockFetchOnce({
      ok: true, status: 200,
      json: {
        model: 'jev-1.13.0',
        answers: { sentiment: { type: 'choice', choice: 'bullish', confidence: 0.78, probabilities: { bullish: 0.8, bearish: 0.15, neutral: 0.05 } } },
        usage: { input_tokens: 500, output_tokens: 0 },
      },
    });
    const result = await provider.evaluate('FDA approval announced', {
      sentiment: { type: 'choice', instructions: 'Classify news sentiment', criteria: { bullish: 'positive for price', bearish: 'negative for price', neutral: 'no clear direction' } },
    });
    const answer = result.answers.sentiment;
    expect(answer.type).toBe('choice');
    if (answer.type === 'choice') {
      expect(answer.choice).toBe('bullish');
      expect(answer.confidence).toBe(0.78);
      expect(answer.probabilities.bullish).toBe(0.8);
    }
  });

  it('parses score answers and validates finiteness', async () => {
    mockFetchOnce({
      ok: true, status: 200,
      json: {
        model: 'jev-1.13.0',
        answers: { urgency: { type: 'score', score: 2, confidence: 0.9, legend: { '0': 'low', '1': 'med', '2': 'high' }, probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 } } },
        usage: { input_tokens: 200, output_tokens: 0 },
      },
    });
    const result = await provider.evaluate('halt pending news', {
      urgency: { type: 'score', instructions: 'Rate urgency', criteria: ['low', 'med', 'high'] },
    });
    const answer = result.answers.urgency;
    expect(answer.type).toBe('score');
    if (answer.type === 'score') expect(answer.score).toBe(2);
  });

  it('fails closed when an answer is missing for a requested question', async () => {
    mockFetchOnce({ ok: true, status: 200, json: { model: 'jev-1.13.0', answers: {}, usage: {} } });
    await expect(provider.askYesNo('x', 'y?')).rejects.toThrow(JevAnswerValidationError);
  });

  it('fails closed on a non-finite noul probability (never invents one)', async () => {
    mockFetchOnce({
      ok: true, status: 200,
      json: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 'high' } }, usage: {} },
    });
    await expect(provider.askYesNo('x', 'y?')).rejects.toThrow(JevAnswerValidationError);
  });

  it('fails closed when a choice answer names an undeclared option', async () => {
    mockFetchOnce({
      ok: true, status: 200,
      json: {
        model: 'jev-1.13.0',
        answers: { s: { type: 'choice', choice: 'moon', confidence: 0.9, probabilities: { moon: 1 } } },
        usage: {},
      },
    });
    await expect(provider.evaluate('x', {
      s: { type: 'choice', instructions: 'sentiment', criteria: { bullish: 'up', bearish: 'down' } },
    })).rejects.toThrow(JevAnswerValidationError);
  });

  it('fails closed on type mismatch between question and answer', async () => {
    mockFetchOnce({
      ok: true, status: 200,
      json: { model: 'jev-1.13.0', answers: { q: { type: 'choice', choice: 'bullish', confidence: 0.9, probabilities: { bullish: 1 } } }, usage: {} },
    });
    await expect(provider.askYesNo('x', 'y?')).rejects.toThrow(JevAnswerValidationError);
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'slow down', json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.5 } }, usage: {} }), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider.askYesNo('x', 'y?');
    expect(result.probabilityYes).toBe(0.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 401 — surfaces the auth failure immediately', async () => {
    const fetchMock = mockFetchOnce({ ok: false, status: 401, statusText: 'Unauthorized', text: 'bad key' });
    await expect(provider.askYesNo('x', 'y?')).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 422 — a malformed request is our bug, not a transient', async () => {
    const fetchMock = mockFetchOnce({ ok: false, status: 422, statusText: 'Unprocessable Entity', text: 'bad question' });
    await expect(provider.askYesNo('x', 'y?')).rejects.toThrow('422');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chat/stream/embeddings/vision/image refuse — Jev generates no text', async () => {
    await expect(provider.chat('hello')).rejects.toThrow('does not generate text');
    await expect(provider.embeddings('hello')).rejects.toThrow('does not generate text');
    await expect(provider.vision(Buffer.from('x'), 'p')).rejects.toThrow('does not generate text');
    await expect(provider.image('p')).rejects.toThrow('does not generate text');
    await expect((async () => { for await (const _ of provider.stream('x')) { /* drain */ } })()).rejects.toThrow('does not generate text');
  });

  it('estimateCost bills input at the vendor list price and ignores output', () => {
    expect(provider.estimateCost(1_000_000, 0)).toBeCloseTo(JEV_INPUT_USD_PER_MILLION_TOKENS, 10);
    expect(provider.estimateCost(1_000_000, 999_999)).toBeCloseTo(JEV_INPUT_USD_PER_MILLION_TOKENS, 10);
  });

  it('honors a pinned model over the jev-latest alias', async () => {
    const fetchMock = mockFetchOnce({
      ok: true, status: 200,
      json: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.1 } }, usage: {} },
    });
    await provider.evaluate('x', { q: { type: 'noul', instructions: 'y?' } }, { model: 'jev-1.13.0' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.model).toBe('jev-1.13.0');
  });

  it('evaluate() without a key throws before any network call', async () => {
    const noKey = new JevProvider();
    await noKey.initialize('');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(noKey.askYesNo('x', 'y?')).rejects.toThrow('not authenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
