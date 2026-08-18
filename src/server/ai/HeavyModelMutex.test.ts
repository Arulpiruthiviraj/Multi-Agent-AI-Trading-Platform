import { describe, it, expect, beforeEach } from 'vitest';
import { heavyModelMutex } from './HeavyModelMutex';

describe('HeavyModelMutex - real concurrency gate for 14B local models', () => {
  it('does not gate a non-heavy model at all - runs immediately, unlimited concurrency', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = () => heavyModelMutex.run('llama3.2:latest', async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
    });
    await Promise.all([run(), run(), run(), run()]);
    expect(maxConcurrent).toBeGreaterThan(1); // real proof of no gating
  });

  it('CRITICAL: serializes heavy models (qwen2.5:14b / deepseek-r1:14b) to maxConcurrentHeavyModels', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = (model: string) => heavyModelMutex.run(model, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
    });
    await Promise.all([run('qwen2.5:14b'), run('deepseek-r1:14b'), run('qwen2.5:14b')]);
    expect(maxConcurrent).toBe(1); // real proof of serialization across BOTH heavy model names
  });

  it('a failing heavy-model call still releases the slot for the next queued call', async () => {
    const results: string[] = [];
    const p1 = heavyModelMutex.run('deepseek-r1:14b', async () => {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('simulated failure');
    }).catch(() => results.push('first-failed'));
    const p2 = heavyModelMutex.run('deepseek-r1:14b', async () => {
      results.push('second-ran');
    });
    await Promise.all([p1, p2]);
    // The real invariant: a failure must not permanently hold the slot - both ran. Exact
    // microtask interleaving between the failing call's own .catch() and the next queued call's
    // continuation (both scheduled from inside the same finally block) is not a guarantee this
    // mutex needs to make, so this checks membership, not order.
    expect(results.sort()).toEqual(['first-failed', 'second-ran']);
  });
});
