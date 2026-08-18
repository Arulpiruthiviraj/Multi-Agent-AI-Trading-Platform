/**
 * ==========================================================
 * Module: ai/HeavyModelMutex
 *
 * Purpose:
 * Real concurrency gate for local Ollama models flagged as "heavy" in config/aiModels.json
 * (qwen2.5:14b, deepseek-r1:14b on this machine). A single consumer laptop GPU cannot hold two
 * 14B-parameter models resident simultaneously without real risk of an OOM driver crash - this
 * serializes calls to those specific models to at most `maxConcurrentHeavyModels` (from config,
 * currently 1), while every OTHER model (fingpt, plutus, llama3.2 variants) is completely
 * unaffected and runs with no throttling at all.
 *
 * Deliberately does NOT touch the live decision spine's timing - agents that don't call a heavy
 * model never wait on this at all, and RiskEngine/OMS/broker calls never pass through here.
 * Bounded queue (`maxQueueDepth`): once the queue is full, a new heavy-model request fails fast
 * with a real error rather than growing an unbounded backlog - the caller's own existing
 * fail-closed handling (HOLD/confidence 0) takes it from there, exactly like any other AI failure.
 * ==========================================================
 */
import { aiModels, isHeavyModel } from '../config/aiModels';

class HeavyModelMutex {
  private active = 0;
  private queue: Array<() => void> = [];

  async run<T>(model: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!isHeavyModel(model)) return fn(); // not a heavy model - no gating at all

    if (this.active >= aiModels.concurrency.maxConcurrentHeavyModels) {
      if (this.queue.length >= aiModels.concurrency.maxQueueDepth) {
        throw new Error(`HeavyModelMutex queue full (${aiModels.concurrency.maxQueueDepth}) - too many concurrent ${model} requests.`);
      }
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Test-only introspection. */
  public state() {
    return { active: this.active, queued: this.queue.length };
  }
}

export const heavyModelMutex = new HeavyModelMutex();
