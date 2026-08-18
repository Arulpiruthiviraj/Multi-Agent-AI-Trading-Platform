import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const logsDir = path.resolve(process.cwd(), 'logs');
const testFile = path.join(logsDir, 'trades.json');

function cleanup(): void {
  for (const suffix of ['', '.1', '.2', '.3']) {
    try { fs.unlinkSync(testFile + suffix); } catch { /* not present */ }
  }
  try {
    if (fs.existsSync(logsDir) && fs.readdirSync(logsDir).length === 0) fs.rmdirSync(logsDir);
  } catch { /* best-effort */ }
}

describe('Logger legacy JSONL rotation (2026-08-18 observability program, Phase 14/15)', () => {
  afterEach(() => {
    vi.doUnmock('../config/observability');
    vi.resetModules();
    cleanup();
  });

  it('rotates trades.json to trades.json.1 once it crosses legacyJsonlMaxBytes, keeping only legacyJsonlMaxBackups', async () => {
    cleanup();
    vi.doMock('../config/observability', async () => {
      const actual = await vi.importActual<typeof import('../config/observability')>('../config/observability');
      return {
        ...actual,
        observabilityConfig: { ...actual.observabilityConfig, legacyJsonlMaxBytes: 200, legacyJsonlMaxBackups: 2 },
      };
    });
    vi.resetModules();
    const { logTrade } = await import('./Logger');

    // Each record is well under 200 bytes alone, so rotation only kicks in once the file itself
    // (not a single record) crosses the cap - proving rotation checks file size, not record size.
    for (let i = 0; i < 15; i++) {
      logTrade({ symbol: 'ROTTEST', id: `trade-${i}`, qty: i });
    }

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(`${testFile}.1`)).toBe(true);
    // Never more backups than configured.
    expect(fs.existsSync(`${testFile}.3`)).toBe(false);

    const current = fs.readFileSync(testFile, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of current) {
      expect(() => JSON.parse(line)).not.toThrow(); // rotation never splits a record across files
    }
  });

  it('does not rotate a file that has never crossed the size cap', async () => {
    cleanup();
    vi.doMock('../config/observability', async () => {
      const actual = await vi.importActual<typeof import('../config/observability')>('../config/observability');
      return {
        ...actual,
        observabilityConfig: { ...actual.observabilityConfig, legacyJsonlMaxBytes: 10_000_000, legacyJsonlMaxBackups: 2 },
      };
    });
    vi.resetModules();
    const { logTrade } = await import('./Logger');

    logTrade({ symbol: 'NOROT', id: 'trade-1' });

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(`${testFile}.1`)).toBe(false);
  });
});
