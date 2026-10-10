// LABEL: FAULT_INJECTION - machine-checked proof that fault injection is
// structurally unreachable from production code. If this file ever fails, the
// gate is broken: stop everything and fix the gate before touching anything else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('fault-injection gate proof', () => {
  const saved = process.env.ARGUS_FAULT_INJECTION;

  beforeEach(() => {
    delete process.env.ARGUS_FAULT_INJECTION;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ARGUS_FAULT_INJECTION;
    else process.env.ARGUS_FAULT_INJECTION = saved;
  });

  it('flag absent: createFaultInjectionScope() throws FaultInjectionGateError', async () => {
    const { FaultInjectionGateError } = await import('./FaultInjectionGate');
    const { createFaultInjectionScope } = await import('./injectors');
    expect(() => createFaultInjectionScope()).toThrow(FaultInjectionGateError);
  });

  it('flag absent: every injector factory throws before touching anything', async () => {
    const inj = await import('./injectors');
    expect(() => inj.makeTimeoutJevProvider()).toThrow(/FaultInjectionGate/);
    expect(() => inj.makeHangingJevProvider()).toThrow(/FaultInjectionGate/);
    expect(() => inj.makeHttpErrorJevProvider(429)).toThrow(/FaultInjectionGate/);
    expect(() => inj.makeDownJevProvider()).toThrow(/FaultInjectionGate/);
    expect(() => inj.makeFlakyJevProvider(['ok'])).toThrow(/FaultInjectionGate/);
    expect(() => inj.hangingBackupWorkerFactory()).toThrow(/FaultInjectionGate/);
    expect(() => inj.outOfSessionClockMs()).toThrow(/FaultInjectionGate/);
    expect(() => new inj.SimulatedFaultySocket(['open'])).toThrow(/FaultInjectionGate/);
    expect(() => inj.startHeartbeat()).toThrow(/FaultInjectionGate/);
    // Factories that need a scope/db/worker must throw on the gate FIRST,
    // before any argument validation.
    expect(() => inj.injectDbSlowQuery({}, 10, null as never)).toThrow(/FaultInjectionGate/);
    expect(() => inj.injectDbLocked({}, 1, null as never)).toThrow(/FaultInjectionGate/);
    expect(() => inj.feedStaleQuote({}, 'X', 1)).toThrow(/FaultInjectionGate/);
    expect(() => inj.feedFrozenQuote({}, 'X', 1)).toThrow(/FaultInjectionGate/);
    expect(() => inj.feedRollbackQuote({}, 'X')).toThrow(/FaultInjectionGate/);
  });

  it('flag absent: async injector entry points throw too', async () => {
    const inj = await import('./injectors');
    await expect(inj.spawnCrashingChild('fi-gate')).rejects.toThrow(/FaultInjectionGate/);
  });

  it('flag present: the gate opens and scopes disarm cleanly', async () => {
    process.env.ARGUS_FAULT_INJECTION = '1';
    const { isFaultInjectionEnabled, assertFaultInjectionEnabled } = await import('./FaultInjectionGate');
    expect(isFaultInjectionEnabled()).toBe(true);
    expect(() => assertFaultInjectionEnabled('gate-proof')).not.toThrow();

    const { createFaultInjectionScope } = await import('./injectors');
    const scope = createFaultInjectionScope();
    let cleaned = 0;
    scope.onDisarm(() => cleaned++);
    scope.onDisarm(() => cleaned++);
    scope.disarmAll();
    expect(cleaned).toBe(2);
    expect(scope.restorationCount).toBe(0);
    // Disarm is idempotent — no double-cleanup.
    scope.disarmAll();
    expect(cleaned).toBe(2);
  });

  it('flag value must be exactly "1" — truthy lookalikes do not open the gate', async () => {
    const { isFaultInjectionEnabled } = await import('./FaultInjectionGate');
    for (const v of ['true', 'TRUE', 'yes', '0', '']) {
      process.env.ARGUS_FAULT_INJECTION = v;
      expect(isFaultInjectionEnabled()).toBe(false);
    }
  });

  it('STATIC SCAN: no production file imports fault-injection or reads the flag', () => {
    // Production = everything except: the fault-injection directory itself,
    // test files (*.test.ts/*.test.tsx), and non-code assets.
    const violations: string[] = [];
    const skipDirs = new Set(['node_modules', 'dist', '.git', '.venv', 'coverage', '.next', 'quant-core-java']);
    const isAllowedPath = (rel: string) =>
      rel.startsWith('src/server/fault-injection/') ||
      rel.endsWith('.test.ts') ||
      rel.endsWith('.test.tsx');

    const importRe = /(import\s+[^'"]*?from\s*|require\s*\()\s*['"][^'"]*fault-injection[^'"]*['"]/m;
    const gateImportRe = /(import\s+[^'"]*?from\s*|require\s*\()\s*['"][^'"]*FaultInjectionGate[^'"]*['"]/m;
    const flagReadRe = /process\.env\s*\[\s*['"]ARGUS_FAULT_INJECTION['"]\s*\]|process\.env\.ARGUS_FAULT_INJECTION/;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
          continue;
        }
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
        if (isAllowedPath(rel)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (importRe.test(src)) violations.push(`${rel}: imports fault-injection`);
        else if (gateImportRe.test(src)) violations.push(`${rel}: imports FaultInjectionGate`);
        else if (flagReadRe.test(src)) violations.push(`${rel}: reads ARGUS_FAULT_INJECTION`);
      }
    };
    walk(REPO_ROOT);
    expect(violations).toEqual([]);
  });

  it('STATIC SCAN: the flag string appears only in test infra + package.json scripts', () => {
    const hits: string[] = [];
    const skipDirs = new Set(['node_modules', 'dist', '.git', '.venv', 'coverage']);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
          continue;
        }
        const full = path.join(dir, entry.name);
        const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
        if (rel.endsWith('.md')) continue; // docs may describe the flag
        if (/\.(ts|tsx|js|mjs|cjs|json|sh)$/.test(entry.name)) {
          const src = fs.readFileSync(full, 'utf8');
          if (src.includes('ARGUS_FAULT_INJECTION')) hits.push(rel);
        }
      }
    };
    walk(REPO_ROOT);
    const allowed = hits.filter(
      (h) =>
        h.startsWith('src/server/fault-injection/') ||
        h === 'package.json' ||
        h === 'package-lock.json',
    );
    const unexpected = hits.filter((h) => !allowed.includes(h));
    expect(unexpected).toEqual([]);
  });
});
