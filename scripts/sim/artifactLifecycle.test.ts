import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDiskSpace, cleanTestArtifacts, isProtectedArtifact, loadArtifactPolicy, retainSessionEvidence } from './artifactLifecycle';

const policy = loadArtifactPolicy(path.resolve(__dirname, '..', '..'));
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'artlife_test_'));

describe('artifactLifecycle (REGRESSION 2026-10-14: 4.3 GB free + a cleanup that deleted certification-session databases)', () => {
  it('policy comes from config and protects certification evidence prefixes', () => {
    expect(policy.minFreeDiskGb).toBeGreaterThan(0);
    expect(isProtectedArtifact('argus_synthetic_sim_full-session-abc.db', policy)).toBe(true);
    expect(isProtectedArtifact('argus_unit_test_123.db', policy)).toBe(false);
  });
  it('disk preflight refuses to start below the configured floor and passes above it', () => {
    expect(() => assertDiskSpace('/x', policy.minFreeDiskGb, () => policy.minFreeDiskGb - 0.5)).toThrow(/requires >=/);
    expect(assertDiskSpace('/x', policy.minFreeDiskGb, () => policy.minFreeDiskGb + 1)).toBeGreaterThan(policy.minFreeDiskGb);
  });
  it('cleanup removes stale unit-test leftovers but NEVER a protected evidence database, a recent file, or an unrelated file', () => {
    const dir = mk();
    const now = Date.now(); const old = new Date(now - (policy.testArtifactMaxAgeMinutes + 30) * 60_000);
    const touch = (name: string, mtime: Date) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); fs.utimesSync(f, mtime, mtime); };
    touch('argus_stale_unit_test.db', old);
    touch('argus-funnel-preidea-1', old);
    touch('argus_synthetic_sim_full-session-evidence.db', old);   // protected
    touch('argus_oct14_postclose_x.db', old);                       // protected
    touch('argus_recent_unit_test.db', new Date(now - 60_000));    // too recent
    touch('unrelated_user_file.db', old);                           // not a test prefix
    const r = cleanTestArtifacts(dir, policy, { nowMs: now });
    expect(r.removed.sort()).toEqual(['argus-funnel-preidea-1', 'argus_stale_unit_test.db']);
    expect(fs.existsSync(path.join(dir, 'argus_synthetic_sim_full-session-evidence.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'argus_oct14_postclose_x.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'argus_recent_unit_test.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'unrelated_user_file.db'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('teardown mode (createdSince) only touches this run\'s leftovers and still never touches protected evidence', () => {
    const dir = mk(); const now = Date.now();
    const touch = (name: string, mtime: number) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(mtime), new Date(mtime)); };
    touch('argus_before_run.db', now - 3 * 3600_000);
    touch('argus_during_run_idle.db', now - 300_000);
    touch('argus_concurrent_active.db', now - 1000);                 // another suite's live database: modified seconds ago
    touch('argus_synthetic_sim_during_run.db', now - 300_000);
    const r = cleanTestArtifacts(dir, policy, { nowMs: now, createdSinceMs: now - 600_000 });
    expect(r.removed).toEqual(['argus_during_run_idle.db']);
    expect(fs.existsSync(path.join(dir, 'argus_concurrent_active.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'argus_before_run.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'argus_synthetic_sim_during_run.db'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('session evidence retention copies the database (and WAL) beside the result artifact, and refuses when the disk is too full', () => {
    const dir = mk(); const db = path.join(dir, 'session.db'); fs.writeFileSync(db, 'DBDATA'); fs.writeFileSync(db + '-wal', 'WAL');
    const out = path.join(dir, 'out', 'result.json');
    const ok = retainSessionEvidence(db, out, policy, () => 1000);
    expect(ok.retained).toBe(true);
    expect(fs.readFileSync(ok.path as string, 'utf8')).toBe('DBDATA');
    expect(fs.existsSync((ok.path as string) + '-wal')).toBe(true);
    const full = retainSessionEvidence(db, out, policy, () => 0.1);
    expect(full).toMatchObject({ retained: false, reason: 'INSUFFICIENT_DISK_FOR_RETENTION' });
    expect(retainSessionEvidence(path.join(dir, 'missing.db'), out, policy, () => 1000).reason).toBe('DB_NOT_FOUND');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
