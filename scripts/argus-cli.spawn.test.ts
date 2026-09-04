import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildEngineSpawnArgs } from './argus-cli';

/**
 * Silent-engine-death investigation (2026-09-04): a live silent death was traced to a real,
 * confirmed process topology - startEngine()'s --dev path used to spawn tsx's CLI wrapper
 * (node_modules/tsx/dist/cli.mjs), which itself forks a SEPARATE child process to actually run
 * argus-engine.ts. Two distinct node.exe processes (wrapper -> real engine) is a real risk on
 * Windows (Job Object propagation can tear down a child when its parent exits, even with
 * detached:true - this host has already shown non-standard process semantics once via DEF-26).
 * These tests lock in the fix: the engine is launched as a single process via tsx's own public
 * loader hooks, never via the cli.mjs wrapper.
 */
describe('buildEngineSpawnArgs', () => {
  it('never spawns tsx/dist/cli.mjs (the wrapper that forks a separate real-engine child)', () => {
    const dev = buildEngineSpawnArgs(false, 'C:\\fake-root');
    const prod = buildEngineSpawnArgs(true, 'C:\\fake-root');
    for (const spec of [dev, prod]) {
      expect(spec.args.some((a) => /tsx[\\/]dist[\\/]cli\.mjs/.test(a))).toBe(false);
    }
  });

  it('dev mode launches argus-engine.ts as the target of a direct node invocation using tsx\'s public loader hooks', () => {
    const root = 'C:\\fake-root';
    const { args } = buildEngineSpawnArgs(false, root);
    expect(args).toEqual([
      '--require', 'tsx/preflight',
      '--import', 'tsx',
      join(root, 'scripts', 'argus-engine.ts'),
    ]);
  });

  it('prod mode launches the compiled prod entry directly, unaffected by the dev-mode fix', () => {
    const root = 'C:\\fake-root';
    const { args } = buildEngineSpawnArgs(true, root);
    expect(args).toEqual([join(root, 'scripts', 'argus-engine-prod.mjs')]);
  });

  it('is a pure function - identical inputs always produce identical, deterministic output', () => {
    const a = buildEngineSpawnArgs(false, '/root');
    const b = buildEngineSpawnArgs(false, '/root');
    expect(a).toEqual(b);
  });
});
