/**
 * Tests for the engine-side maintenance-state publisher (defect #3): a best-effort, atomic
 * writer the watchdog reads to distinguish known maintenance from a genuinely dead process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  publishMaintenanceState,
  setMaintenanceStatePathForTests,
  resetMaintenanceStateForTests,
} from './maintenanceState';

describe('maintenanceState publisher', () => {
  let dir: string;
  let maintPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argus-maintpub-'));
    maintPath = join(dir, '.argus_maintenance_state.json');
    setMaintenanceStatePathForTests(maintPath);
  });
  afterEach(() => {
    resetMaintenanceStateForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a patch atomically with a refreshed updatedAt', () => {
    expect(publishMaintenanceState({ shutdownInProgress: true })).toBe(true);
    const raw = JSON.parse(readFileSync(maintPath, 'utf8'));
    expect(raw.shutdownInProgress).toBe(true);
    expect(typeof raw.updatedAt).toBe('string');
    // No temp file left behind.
    expect(() => readFileSync(`${maintPath}.${process.pid}.tmp`, 'utf8')).toThrow();
  });

  it('merges patches over the previous file instead of clobbering', () => {
    publishMaintenanceState({ backup: { state: 'RUNNING', startedAt: '2026-10-08T00:00:00.000Z' } });
    publishMaintenanceState({ shutdownInProgress: true });
    const raw = JSON.parse(readFileSync(maintPath, 'utf8'));
    expect(raw.backup.state).toBe('RUNNING');
    expect(raw.shutdownInProgress).toBe(true);
  });

  it('recovers from a corrupt existing file by overwriting it', () => {
    writeFileSync(maintPath, '{corrupt');
    expect(publishMaintenanceState({ shutdownInProgress: true })).toBe(true);
    const raw = JSON.parse(readFileSync(maintPath, 'utf8'));
    expect(raw.shutdownInProgress).toBe(true);
  });

  it('never throws - returns false when the publish target is unwritable', () => {
    // Point at a path inside a nonexistent location under a read-only parent is awkward to
    // construct portably; instead use a directory as the target file (rename onto a non-empty
    // dir fails on POSIX, write fails on all platforms).
    setMaintenanceStatePathForTests(dir);
    expect(publishMaintenanceState({ shutdownInProgress: true })).toBe(false);
  });
});
