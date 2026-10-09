/**
 * Tests for the maintenance-state contract reader (defect #3: distinguish "heartbeat stale
 * because of known maintenance" from "process genuinely dead").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateMaintenanceSignal,
  readMaintenanceSignal,
} from './watchdogMaintenanceState';

const NOW = 1_700_000_000_000;
const FRESHNESS = 300_000;

describe('evaluateMaintenanceSignal', () => {
  it('returns a signal for a fresh backup:RUNNING claim', () => {
    const raw = {
      updatedAt: new Date(NOW - 10_000).toISOString(),
      backup: { state: 'RUNNING', startedAt: new Date(NOW - 60_000).toISOString() },
    };
    const sig = evaluateMaintenanceSignal(raw, NOW, FRESHNESS);
    expect(sig).not.toBeNull();
    expect(sig!.kind).toBe('backup:RUNNING');
  });

  it('returns a signal for fresh startup/shutdown claims', () => {
    const sig = evaluateMaintenanceSignal(
      { updatedAt: new Date(NOW - 1_000).toISOString(), shutdownInProgress: true },
      NOW,
      FRESHNESS,
    );
    expect(sig?.kind).toBe('shutdown');
  });

  it('returns null when no maintenance is active (backup IDLE, flags false)', () => {
    const sig = evaluateMaintenanceSignal(
      { updatedAt: new Date(NOW - 1_000).toISOString(), backup: { state: 'IDLE' }, startupInProgress: false },
      NOW,
      FRESHNESS,
    );
    expect(sig).toBeNull();
  });

  it('returns null for a STALE signal - a dead publisher must never pin deferral (fail closed)', () => {
    const sig = evaluateMaintenanceSignal(
      { updatedAt: new Date(NOW - FRESHNESS - 1).toISOString(), backup: { state: 'RUNNING' } },
      NOW,
      FRESHNESS,
    );
    expect(sig).toBeNull();
  });

  it('returns null for missing updatedAt or garbage input', () => {
    expect(evaluateMaintenanceSignal({ backup: { state: 'RUNNING' } }, NOW, FRESHNESS)).toBeNull();
    expect(evaluateMaintenanceSignal(null, NOW, FRESHNESS)).toBeNull();
    expect(evaluateMaintenanceSignal('garbage', NOW, FRESHNESS)).toBeNull();
    expect(evaluateMaintenanceSignal({ updatedAt: 'not-a-date', backup: { state: 'RUNNING' } }, NOW, FRESHNESS)).toBeNull();
  });

  it('treats an updatedAt in the future as untrusted, not fresh', () => {
    const sig = evaluateMaintenanceSignal(
      { updatedAt: new Date(NOW + 60_000).toISOString(), backup: { state: 'RUNNING' } },
      NOW,
      FRESHNESS,
    );
    expect(sig).toBeNull();
  });

  it('ignores an unknown backup state string rather than inventing meaning', () => {
    const sig = evaluateMaintenanceSignal(
      { updatedAt: new Date(NOW - 1_000).toISOString(), backup: { state: 'SOME_FUTURE_STATE' } },
      NOW,
      FRESHNESS,
    );
    expect(sig).toBeNull();
  });
});

describe('readMaintenanceSignal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argus-maint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a missing file', () => {
    expect(readMaintenanceSignal(join(dir, 'nope.json'), NOW, FRESHNESS)).toBeNull();
  });

  it('returns null for a corrupt file', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{not json');
    expect(readMaintenanceSignal(p, Date.now(), FRESHNESS)).toBeNull();
  });

  it('reads a real file end to end', () => {
    const p = join(dir, 'maint.json');
    writeFileSync(p, JSON.stringify({
      updatedAt: new Date(Date.now() - 5_000).toISOString(),
      backup: { state: 'RUNNING' },
    }));
    const sig = readMaintenanceSignal(p, Date.now(), FRESHNESS);
    expect(sig?.kind).toBe('backup:RUNNING');
  });
});
