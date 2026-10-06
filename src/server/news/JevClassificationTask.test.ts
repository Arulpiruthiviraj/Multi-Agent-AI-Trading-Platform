/**
 * JevClassificationTask — generic runner tests (mocked provider, no network).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  JevClassificationTask,
  runClassificationTask,
  isTaskEnabled,
} from './JevClassificationTask';
import { JevProvider } from '../ai/providers/JevProvider';

const TASK: JevClassificationTask<{ text: string }, { label: string }> = {
  taskId: 'test-task',
  flagEnvVar: 'ARGUS_JEV_TEST_TASK_ENABLED',
  buildState: (input: unknown) => {
    const text = (input as { text?: unknown })?.text;
    return typeof text === 'string' && text.trim() ? { text: text.trim() } : null;
  },
  buildQuestions: () => ({
    q: { type: 'noul', instructions: 'Is this positive?' },
  }),
  mapAnswer: (answers) => {
    const a = answers.q as { type: string; noul: number };
    if (a?.type !== 'noul' || !Number.isFinite(a.noul)) throw new Error('bad answer');
    return { label: a.noul >= 0.5 ? 'pos' : 'neg' };
  },
};

describe('runClassificationTask', () => {
  const ORIGINAL = process.env.ARGUS_JEV_TEST_TASK_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ARGUS_JEV_TEST_TASK_ENABLED;
    else process.env.ARGUS_JEV_TEST_TASK_ENABLED = ORIGINAL;
  });

  function mockProvider(noul: number): JevProvider {
    const provider = new JevProvider();
    vi.spyOn(provider, 'evaluate').mockResolvedValue({
      model: 'jev-1.13.0',
      answers: { q: { type: 'noul', noul } },
      inputTokens: 100,
      outputTokens: 0,
    });
    return provider;
  }

  it('returns null when the flag is off — zero behavior change', async () => {
    delete process.env.ARGUS_JEV_TEST_TASK_ENABLED;
    expect(isTaskEnabled(TASK)).toBe(false);
    const provider = mockProvider(0.9);
    const spy = vi.spyOn(provider, 'evaluate');
    expect(await runClassificationTask(TASK, provider, { text: 'hello' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs the full task in one batched call when enabled', async () => {
    process.env.ARGUS_JEV_TEST_TASK_ENABLED = 'true';
    const provider = mockProvider(0.9);
    const out = await runClassificationTask(TASK, provider, { text: 'hello' });
    expect(out?.result).toEqual({ label: 'pos' });
    expect(out?.model).toBe('jev-1.13.0');
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns null on imperfect state — no request made', async () => {
    process.env.ARGUS_JEV_TEST_TASK_ENABLED = 'true';
    const provider = mockProvider(0.9);
    const spy = vi.spyOn(provider, 'evaluate');
    expect(await runClassificationTask(TASK, provider, { text: '   ' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null when the provider throws — caller falls back', async () => {
    process.env.ARGUS_JEV_TEST_TASK_ENABLED = 'true';
    const provider = new JevProvider();
    vi.spyOn(provider, 'evaluate').mockRejectedValue(new Error('down'));
    expect(await runClassificationTask(TASK, provider, { text: 'hello' })).toBeNull();
  });

  it('returns null when the answer mapping throws — never invents', async () => {
    process.env.ARGUS_JEV_TEST_TASK_ENABLED = 'true';
    const provider = new JevProvider();
    vi.spyOn(provider, 'evaluate').mockResolvedValue({
      model: 'jev-1.13.0',
      answers: { q: { type: 'noul', noul: Number.NaN } },
      inputTokens: 100,
      outputTokens: 0,
    });
    expect(await runClassificationTask(TASK, provider, { text: 'hello' })).toBeNull();
  });
});
