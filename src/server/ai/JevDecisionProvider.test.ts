/**
 * JevDecisionProvider — structured-decision provider tests (mocked HTTP, no
 * network, no real API key). Proves: NO_API_KEY with zero network attempt,
 * typed parsing per question type, one HTTP call for multi-question requests,
 * and the full error-classification table. The key must never appear in any
 * thrown message or logged output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JevDecisionProvider,
  JevError,
  type JevDecisionRequest,
  type JevQuestion,
} from './JevDecisionProvider';

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
const MODELS_URL = 'https://api.typesafe.ai/v1/models';
/** Deliberately distinctive so a leak into any message/log is unmistakable. */
const TEST_KEY = 'sk-test-jev-key-DO-NOT-USE-9f8e7d6c5b4a';

function okResponse(json: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => json, text: async () => '' };
}

function errResponse(status: number, statusText: string, text = '') {
  return { ok: false, status, statusText, json: async () => ({}), text: async () => text };
}

function stubFetch(impl: (...args: any[]) => any) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** fetch mock that never resolves but honors abort (like a hung request);
 * rejects with AbortError when the passed signal aborts — including when it
 * is already aborted, mirroring real fetch behavior. */
function hangingFetch() {
  return stubFetch((_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal as AbortSignal | undefined;
      const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (sig?.aborted) onAbort();
      else sig?.addEventListener('abort', onAbort);
    }),
  );
}
function decideRequest(overrides?: Partial<JevDecisionRequest>): JevDecisionRequest {
  const questions: Record<string, JevQuestion> = {
    bullish: { type: 'noul', instructions: 'Is this news bullish for the stock?' },
    sentiment: {
      type: 'choice',
      instructions: 'Classify news sentiment',
      criteria: { bullish: 'positive for price', bearish: 'negative for price', neutral: 'no clear direction' },
    },
    urgency: { type: 'score', instructions: 'Rate urgency', criteria: ['low', 'med', 'high'] },
  };
  return {
    state: 'earnings beat, raised guidance',
    questions,
    schemaVersion: '1',
    ...overrides,
  };
}

function answersJson() {
  return {
    model: 'jev-1.13.0',
    answers: {
      bullish: { type: 'noul', noul: 0.83 },
      sentiment: { type: 'choice', choice: 'bullish', confidence: 0.78, probabilities: { bullish: 0.8, bearish: 0.15, neutral: 0.05 } },
      urgency: { type: 'score', score: 2, confidence: 0.9, legend: { '0': 'low', '1': 'med', '2': 'high' }, probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 } },
    },
    usage: { input_tokens: 392, output_tokens: 0 },
  };
}

describe('JevDecisionProvider', () => {
  let savedJev: string | undefined;
  let savedTypesafe: string | undefined;

  beforeEach(() => {
    savedJev = process.env.JEV_API_KEY;
    savedTypesafe = process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    JevDecisionProvider.getInstance().resetForTests();
  });

  afterEach(() => {
    if (savedJev !== undefined) process.env.JEV_API_KEY = savedJev; else delete process.env.JEV_API_KEY;
    if (savedTypesafe !== undefined) process.env.TYPESAFE_API_KEY = savedTypesafe; else delete process.env.TYPESAFE_API_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('isConfigured() reflects env presence without touching the network', () => {
    const fetchMock = stubFetch(() => { throw new Error('must not be called'); });
    const p = JevDecisionProvider.getInstance();
    expect(p.isConfigured()).toBe(false);
    process.env.JEV_API_KEY = TEST_KEY;
    expect(p.isConfigured()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to TYPESAFE_API_KEY when JEV_API_KEY is unset', async () => {
    process.env.TYPESAFE_API_KEY = 'typesafe-fallback-key';
    const fetchMock = stubFetch(async () => okResponse(answersJson()));
    const result = await JevDecisionProvider.getInstance().decide(decideRequest());
    expect(result.model).toBe('jev-1.13.0');
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer typesafe-fallback-key');
  });

  it('throws NO_API_KEY with zero network attempt when no key is configured', async () => {
    const fetchMock = stubFetch(() => { throw new Error('must not be called'); });
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('NO_API_KEY');
    expect((err as JevError).retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses noul/choice/score answers with model, tokens, and latency', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async () => okResponse(answersJson()));
    const result = await JevDecisionProvider.getInstance().decide(decideRequest());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SYSTEMONE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe('jev-latest');

    expect(result.model).toBe('jev-1.13.0');
    expect(result.inputTokens).toBe(392);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const bullish = result.answers.bullish;
    expect(bullish.type).toBe('noul');
    if (bullish.type === 'noul') expect(bullish.noul).toBe(0.83);

    const sentiment = result.answers.sentiment;
    expect(sentiment.type).toBe('choice');
    if (sentiment.type === 'choice') {
      expect(sentiment.choice).toBe('bullish');
      expect(sentiment.confidence).toBe(0.78);
    }

    const urgency = result.answers.urgency;
    expect(urgency.type).toBe('score');
    if (urgency.type === 'score') expect(urgency.score).toBe(2);
  });

  it('sends multiple questions in a SINGLE request (fetch called once for 4 questions)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async () =>
      okResponse({
        model: 'jev-1.13.0',
        answers: {
          q1: { type: 'noul', noul: 0.1 },
          q2: { type: 'noul', noul: 0.2 },
          q3: { type: 'noul', noul: 0.3 },
          q4: { type: 'noul', noul: 0.4 },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
    );
    const result = await JevDecisionProvider.getInstance().decide(
      decideRequest({
        questions: {
          q1: { type: 'noul', instructions: 'one?' },
          q2: { type: 'noul', instructions: 'two?' },
          q3: { type: 'noul', instructions: 'three?' },
          q4: { type: 'noul', instructions: 'four?' },
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(sent.questions)).toHaveLength(4);
    expect(Object.keys(result.answers)).toHaveLength(4);
    // decide() never uses the models endpoint
    expect(fetchMock.mock.calls[0][0]).toBe(SYSTEMONE_URL);
  });

  it('missing answer for a requested question -> VALIDATION (not retryable)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    stubFetch(async () => okResponse({ model: 'jev-1.13.0', answers: {}, usage: {} }));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('VALIDATION');
    expect((err as JevError).retryable).toBe(false);
  });

  it('malformed (non-finite) answer value -> VALIDATION', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    stubFetch(async () =>
      okResponse({ model: 'jev-1.13.0', answers: { bullish: { type: 'noul', noul: 'high' }, sentiment: { type: 'noul', noul: 0.5 }, urgency: { type: 'noul', noul: 0.5 } }, usage: {} }),
    );
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('VALIDATION');
  });

  it('malformed JSON body -> VALIDATION', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    stubFetch(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      text: async () => '<html>not json</html>',
    }));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('VALIDATION');
    expect((err as JevError).retryable).toBe(false);
  });

  it('429 -> RATE_LIMIT (retryable), after the provider exhausts its own retries', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async () => errResponse(429, 'Too Many Requests', 'slow down'));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('RATE_LIMIT');
    expect((err as JevError).status).toBe(429);
    expect((err as JevError).retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 provider retries
  });

  it('401 -> AUTH (not retryable), no provider retry', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async () => errResponse(401, 'Unauthorized', 'bad key'));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('AUTH');
    expect((err as JevError).status).toBe(401);
    expect((err as JevError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('500 -> SERVER (retryable)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async () => errResponse(500, 'Internal Server Error', 'boom'));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('SERVER');
    expect((err as JevError).status).toBe(500);
    expect((err as JevError).retryable).toBe(true);
  });

  it('529 -> OVERLOAD (retryable)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    stubFetch(async () => errResponse(529, 'Overloaded', 'busy'));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('OVERLOAD');
    expect((err as JevError).status).toBe(529);
    expect((err as JevError).retryable).toBe(true);
  });

  it('422 -> VALIDATION (not retryable)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    stubFetch(async () => errResponse(422, 'Unprocessable Entity', 'bad question'));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('VALIDATION');
    expect((err as JevError).status).toBe(422);
    expect((err as JevError).retryable).toBe(false);
  });

  it('fetch network failure -> NETWORK (retryable)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    stubFetch(async () => { throw new TypeError('fetch failed'); });
    const err = await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('NETWORK');
    expect((err as JevError).retryable).toBe(true);
  });

  it('our timer firing -> TIMEOUT (retryable), even though the provider also aborts internally', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    hangingFetch();
    const err = await JevDecisionProvider.getInstance()
      .decide(decideRequest({ timeoutMs: 50 }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('TIMEOUT');
    expect((err as JevError).retryable).toBe(true);
  }, 10000);

  it('external AbortSignal -> ABORTED (not retryable)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    hangingFetch();
    const external = new AbortController();
    const pending = JevDecisionProvider.getInstance().decide(decideRequest({ signal: external.signal }));
    external.abort();
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('ABORTED');
    expect((err as JevError).retryable).toBe(false);
  }, 10000);

  it('empty questions map -> VALIDATION before any network attempt', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async () => okResponse(answersJson()));
    const err = await JevDecisionProvider.getInstance().decide(decideRequest({ questions: {} })).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('VALIDATION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discoverModels hits GET /v1/models and parses model ids (smoke-test only)', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const fetchMock = stubFetch(async (url: string) => {
      expect(url).toBe(MODELS_URL);
      return okResponse({ data: [{ id: 'jev-1.13.0' }, { id: 'jev-latest' }] });
    });
    const models = await JevDecisionProvider.getInstance().discoverModels();
    expect(models).toEqual(['jev-1.13.0', 'jev-latest']);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as any).method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('discoverModels without a key -> NO_API_KEY, zero network', async () => {
    const fetchMock = stubFetch(() => { throw new Error('must not be called'); });
    const err = await JevDecisionProvider.getInstance().discoverModels().catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe('NO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the key never appears in any thrown message or logged output', async () => {
    process.env.JEV_API_KEY = TEST_KEY;
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logged.push(a.join(' ')); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { logged.push(a.join(' ')); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: any[]) => { logged.push(a.join(' ')); });

    const errors: unknown[] = [];
    // 401 path
    stubFetch(async () => errResponse(401, 'Unauthorized', `bad key ${TEST_KEY} echoed?`));
    errors.push(await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e));
    // validation path
    stubFetch(async () => okResponse({ model: 'x', answers: {}, usage: {} }));
    errors.push(await JevDecisionProvider.getInstance().decide(decideRequest()).catch((e) => e));
    // isConfigured / NO_API_KEY paths touch no network
    expect(JevDecisionProvider.getInstance().isConfigured()).toBe(true);

    for (const e of errors) {
      expect(e).toBeInstanceOf(JevError);
      expect(String(e)).not.toContain(TEST_KEY);
      expect((e as Error).stack ?? '').not.toContain(TEST_KEY);
    }
    expect(logged.join('\n')).not.toContain(TEST_KEY);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
