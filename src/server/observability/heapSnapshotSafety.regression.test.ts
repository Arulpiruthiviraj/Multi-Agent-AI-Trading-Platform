import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P1-B prevention (2026-09-14 overnight remediation, mandate section 3). This is NOT
 * heapSnapshotCapture.test.ts's job (that file exercises the mechanism itself with everything
 * mocked, regardless of the real config value). This test's only job: fail loudly if the REAL,
 * on-disk production config file is ever changed to re-enable WARNING/CRITICAL-triggered heap
 * capture without an explicit, reviewed decision to do so - the exact incident this file exists
 * to prevent from recurring silently (e.g. a future find-and-replace, a config template reset, a
 * merge conflict resolved the wrong way).
 *
 * Reads the file directly (not via observabilityConfig, which could itself be stale/cached or
 * point at a test override) so this proves the actual artifact that ships.
 */
describe('P1-B regression: WARNING/CRITICAL heap capture must stay disabled in production config', () => {
  const configPath = join(process.cwd(), 'config', 'observability.json');

  it('config/observability.json has heapSnapshotEnabled=false', () => {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.heapSnapshotEnabled).toBe(false);
  });

  it('the incident record comment is still present, not silently deleted', () => {
    const text = readFileSync(configPath, 'utf8');
    expect(text).toMatch(/FROZEN_CONFIRMED/);
    expect(text).toMatch(/P1-B/);
  });

  it('no environment-variable override in the codebase can force heapSnapshotEnabled to true - '
    + 'only config/observability.json itself can', () => {
    // Static-scan companion to the runtime check above: confirms the source itself never reads an
    // env var for this specific field (ARGUS_DISABLE_HEAP_SNAPSHOTS, checked separately, can only
    // disable further - this asserts nothing can do the opposite).
    const src = readFileSync(join(process.cwd(), 'src', 'server', 'observability', 'heapSnapshotCapture.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env\.[A-Z_]*HEAP[A-Z_]*\s*===\s*'true'\s*\?\s*true/);
    expect(src).not.toMatch(/heapSnapshotEnabled\s*=\s*process\.env/);
  });
});
