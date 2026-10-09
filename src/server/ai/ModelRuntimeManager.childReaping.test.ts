import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('../core/EventBus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../integrations/openalice/OpenAliceVerificationService', () => ({
  openAliceVerificationService: {
    enabled: false,
    mcpUrl: null,
    health: async () => ({ reachable: false, detail: 'disabled', checkedAt: new Date().toISOString() }),
  },
}));

/**
 * A2 (2026-10-08): ModelRuntimeManager spawned children were never reaped.
 *
 * Defect, proven in code (src/server/ai/ModelRuntimeManager.ts, pre-fix):
 *   - `const children: ChildProcess[] = []` (module scope) was push-only: trySpawn() and
 *     trySpawnChronos() pushed every spawned child, but no code path ever spliced the array,
 *     attached an 'exit'/'error' listener, capped its size, or killed children on shutdown.
 *   - retryUnhealthy() (reachable from the diagnostics route v2System.ts:1916, i.e. repeatedly
 *     operator-triggerable) spawned a fresh Chronos every time the probe failed, without
 *     killing the previous live one - duplicate processes bound to the same port.
 *   - The file had no stop() and no process shutdown hook: children were spawned
 *     detached+unref'd, so they survived engine shutdown as orphans, and the array grew
 *     without bound across retries (ChildProcess objects + listeners never released).
 *
 * Fix: children are tracked in a bounded Set that reaps on 'exit'/'error', refuses (and
 * SIGKILLs) spawns past modelRuntimeMaxChildren, kills live same-label children before
 * retryUnhealthy() re-spawns, and stop() kills every tracked child (wired into the
 * graceful-shutdown drain).
 *
 * These tests spawn real short-lived / sleeping `node` processes through the production
 * tracked-spawn path (never real ollama/python binaries) and prove the reaping behavior.
 */
describe('ModelRuntimeManager child reaping (A2)', () => {
  let spawnTracked: (command: string, args: string[], label: string, extraOpts?: Record<string, unknown>) => ChildProcess | null;
  let trackedCount: () => number;
  let killByLabel: (label: string) => void;
  let manager: { stop: () => void };
  let cap: number;

  const NODE = process.execPath;
  const NO_SHELL = { shell: false }; // kill() must target node itself, not a sh wrapper

  async function pollFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      if (cond()) return true;
      if (Date.now() - start >= timeoutMs) return cond();
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    process.env.ARGUS_START_LOCAL_MODELS = 'false';
    process.env.ARGUS_START_CHRONOS = 'false';
    // Pre-fix these exports do not exist: the tracked/reaped/stop behavior is absent.
    const mod = await import('./ModelRuntimeManager');
    spawnTracked = mod.__spawnModelChildForTests;
    trackedCount = mod.__trackedModelChildCountForTests;
    killByLabel = mod.__killTrackedChildrenByLabelForTests;
    manager = mod.modelRuntimeManager;
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    cap = runtimeIntervals.modelRuntimeMaxChildren ?? 4;
    expect(typeof spawnTracked).toBe('function');
  });

  afterEach(() => {
    // Never leak a sleeper into another test file, even on assertion failure.
    try { manager.stop(); } catch { /* pre-fix: no stop() */ }
  });

  it('reaps a completed child: no lingering tracked entry after exit', async () => {
    const child = spawnTracked(NODE, ['-e', 'process.exit(0)'], 'test-quick-exit', NO_SHELL);
    expect(child).not.toBeNull();
    // The exit is real (not injected): poll until the 'exit' listener reaps the entry.
    expect(await pollFor(() => trackedCount() === 0)).toBe(true);
    expect(trackedCount()).toBe(0);
  });

  it('reaps a child that fails to spawn (error event), not just clean exits', async () => {
    const child = spawnTracked('/nonexistent-binary-argus-a2-test', [], 'test-spawn-error', NO_SHELL);
    // Spawn itself fails: with shell:false node emits 'error' async; the entry must not linger.
    expect(await pollFor(() => trackedCount() === 0)).toBe(true);
    expect(child === null || trackedCount() === 0).toBe(true);
  });

  it('caps concurrent children: spawns past the cap are refused, not leaked', async () => {
    const sleepers: ChildProcess[] = [];
    for (let i = 0; i < cap; i++) {
      const c = spawnTracked(NODE, ['-e', 'setInterval(() => {}, 1000)'], `test-cap-${i}`, NO_SHELL);
      expect(c).not.toBeNull();
      sleepers.push(c!);
    }
    expect(trackedCount()).toBe(cap);
    const extra = spawnTracked(NODE, ['-e', 'setInterval(() => {}, 1000)'], 'test-cap-extra', NO_SHELL);
    expect(extra).toBeNull(); // refused, and the over-cap child is killed, not leaked
    expect(trackedCount()).toBe(cap);
    manager.stop();
    expect(trackedCount()).toBe(0);
    for (const s of sleepers) {
      expect(await pollFor(() => s.exitCode !== null || s.signalCode !== null)).toBe(true);
    }
  });

  it('stop() kills stragglers: a still-running child is dead after stop()', async () => {
    const child = spawnTracked(NODE, ['-e', 'setInterval(() => {}, 1000)'], 'test-straggler', NO_SHELL);
    expect(child).not.toBeNull();
    expect(trackedCount()).toBe(1);
    manager.stop();
    expect(trackedCount()).toBe(0);
    // Real kill, not just bookkeeping: the OS process is actually gone.
    expect(await pollFor(() => child!.exitCode !== null || child!.signalCode !== null)).toBe(true);
    expect(() => manager.stop()).not.toThrow(); // idempotent
  });

  it('label-scoped kill removes live same-label children (the retryUnhealthy dedupe mechanism)', async () => {
    const child = spawnTracked(NODE, ['-e', 'setInterval(() => {}, 1000)'], 'test-dedupe-label', NO_SHELL);
    expect(child).not.toBeNull();
    expect(trackedCount()).toBe(1);
    // retryUnhealthy() calls this same internal kill before re-spawning Chronos, so a retry
    // can never stack a second live child on the same port.
    killByLabel('test-dedupe-label');
    expect(trackedCount()).toBe(0);
    expect(await pollFor(() => child!.exitCode !== null || child!.signalCode !== null)).toBe(true);
    // Other labels are untouched.
    const other = spawnTracked(NODE, ['-e', 'setInterval(() => {}, 1000)'], 'test-other-label', NO_SHELL);
    expect(other).not.toBeNull();
    killByLabel('test-dedupe-label');
    expect(trackedCount()).toBe(1);
  });
});
