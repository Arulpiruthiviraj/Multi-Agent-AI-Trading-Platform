// LABEL: ARCHITECTURE_INVARIANT - proves the synthetic clock-override stays importable only inside the synthetic/forensic harness. Code-shape guarantee, not a runtime trading proof.
/**
 * Unit + architecture-boundary tests for SyntheticWallClockOverride.ts. See that file's header for
 * the design principle this exists to prove: it controls WHEN the real evaluator cycle methods
 * run, never WHAT they compute, and it never leaks outside the scope it was installed for.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { withRunningClock, withFrozenClock, isClockOverrideActive, realNowMs } from './SyntheticWallClockOverride';

const ROOT = process.cwd();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('Architecture protection: SyntheticWallClockOverride stays inside the synthetic/forensic harness', () => {
  it('no file outside src/server/replay/synthetic/ or scripts/forensic/ imports it', () => {
    const files = [...listTsFiles(join(ROOT, 'src')), ...listTsFiles(join(ROOT, 'scripts'))];
    const hits: string[] = [];
    for (const f of files) {
      const path = relative(ROOT, f).replace(/\\/g, '/');
      if (path.startsWith('src/server/replay/synthetic/')) continue;
      if (path.startsWith('scripts/forensic/')) continue;
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*SyntheticWallClockOverride['"]/.test(text)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});

describe('withFrozenClock', () => {
  it('Date.now() and new Date() report the fixed instant throughout fn', async () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z').getTime();
    let observedNow = -1;
    let observedCtor = -1;
    await withFrozenClock(fixed, async () => {
      observedNow = Date.now();
      observedCtor = new Date().getTime();
    });
    expect(observedNow).toBe(fixed);
    expect(observedCtor).toBe(fixed);
  });

  it('restores the native Date after fn resolves, even when fn throws', async () => {
    const before = Date.now();
    await expect(withFrozenClock(before + 999_999, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(isClockOverrideActive()).toBe(false);
    // Native clock is back to reporting real time, not the fixed value.
    expect(Math.abs(Date.now() - realNowMs())).toBeLessThan(50);
  });

  it('refuses to nest a second override while one is active', async () => {
    await withFrozenClock(123456, async () => {
      await expect(withFrozenClock(999, async () => {})).rejects.toThrow(/already active/);
    });
    expect(isClockOverrideActive()).toBe(false);
  });
});

describe('withRunningClock', () => {
  it('advances Date.now() by real elapsed time, offset to the given anchor', async () => {
    const anchor = new Date('2025-06-01T13:30:00.000Z').getTime();
    const samples: number[] = [];
    await withRunningClock(anchor, async () => {
      samples.push(Date.now());
      await new Promise((r) => setTimeout(r, 20));
      samples.push(Date.now());
    });
    expect(samples[0]).toBeGreaterThanOrEqual(anchor);
    expect(samples[1]).toBeGreaterThan(samples[0]);
    // The real elapsed gap (>=20ms) is preserved, just offset into the anchor's epoch - not frozen.
    expect(samples[1] - samples[0]).toBeGreaterThanOrEqual(15);
  });
});
