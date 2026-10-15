/**
 * Synthetic-certification artifact lifecycle (2026-10-14): disk preflight, evidence retention, and a cleanup that can never delete evidence.
 * Policy lives in config/syntheticArtifacts.json (no numbers here). Pure functions take their filesystem seam so they are testable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ArtifactPolicy {
  minFreeDiskGb: number;
  retainSessionDatabases: boolean;
  evidenceSubfolder: string;
  testArtifactMaxAgeMinutes: number;
  testArtifactPrefixes: string[];
  protectedPrefixes: string[];
}

export function loadArtifactPolicy(repoRoot: string = process.cwd()): ArtifactPolicy {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'syntheticArtifacts.json'), 'utf8')) as Record<string, unknown>;
  const num = (k: string): number => { const v = raw[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`config/syntheticArtifacts.json: ${k} must be a non-negative number`); return v; };
  const strs = (k: string): string[] => { const v = raw[k]; if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw new Error(`config/syntheticArtifacts.json: ${k} must be a non-empty string array`); return v as string[]; };
  // DEVELOPMENT-LOOP override only (never for the release run): may lower the threshold but never below 8 GB, and is announced loudly.
  let minFree = num('minFreeDiskGb');
  const override = Number(process.env.ARGUS_SYNTH_MIN_FREE_DISK_GB);
  if (Number.isFinite(override) && override >= 8 && override < minFree) { console.warn(`[artifactLifecycle] DEV OVERRIDE: min free disk lowered ${minFree} -> ${override} GB via ARGUS_SYNTH_MIN_FREE_DISK_GB (not valid for release certification)`); minFree = override; }
  return {
    minFreeDiskGb: minFree, retainSessionDatabases: raw.retainSessionDatabases === true, evidenceSubfolder: String(raw.evidenceSubfolder || 'evidence'),
    testArtifactMaxAgeMinutes: num('testArtifactMaxAgeMinutes'), testArtifactPrefixes: strs('testArtifactPrefixes'), protectedPrefixes: strs('protectedPrefixes'),
  };
}

export function freeDiskGb(dir: string, statfs: (p: string) => { bavail: number | bigint; bsize: number | bigint } = (p) => fs.statfsSync(p)): number {
  const s = statfs(dir);
  return Number(s.bavail) * Number(s.bsize) / (1024 ** 3);
}

/** Refuse to start a long-running certification step when the drive cannot hold its artifacts. */
export function assertDiskSpace(dir: string, minFreeGb: number, free: (d: string) => number = freeDiskGb): number {
  const gb = free(dir);
  if (gb < minFreeGb) throw new Error(`FATAL: only ${gb.toFixed(1)} GB free on the drive holding ${dir}; certification requires >= ${minFreeGb} GB (config/syntheticArtifacts.json). Free space (never delete retained evidence) and rerun.`);
  return gb;
}

export interface RetainResult { retained: boolean; path: string | null; reason: string }

/** Copy a finished session's database (plus WAL/SHM if present) beside the result artifact so oracles can be re-run later. */
export function retainSessionEvidence(dbPath: string, outputPath: string, policy: ArtifactPolicy, free: (d: string) => number = freeDiskGb): RetainResult {
  if (!policy.retainSessionDatabases) return { retained: false, path: null, reason: 'RETENTION_DISABLED' };
  if (!dbPath || !fs.existsSync(dbPath)) return { retained: false, path: null, reason: 'DB_NOT_FOUND' };
  const destDir = path.join(path.dirname(outputPath), policy.evidenceSubfolder);
  const sizeGb = fs.statSync(dbPath).size / (1024 ** 3);
  fs.mkdirSync(destDir, { recursive: true });
  if (free(destDir) < sizeGb + policy.minFreeDiskGb / 3) return { retained: false, path: null, reason: 'INSUFFICIENT_DISK_FOR_RETENTION' };
  const dest = path.join(destDir, path.basename(dbPath));
  for (const suffix of ['', '-wal', '-shm']) { if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, dest + suffix); }
  return { retained: true, path: dest, reason: 'RETAINED' };
}

export function isProtectedArtifact(name: string, policy: ArtifactPolicy): boolean {
  return policy.protectedPrefixes.some((p) => name.startsWith(p));
}

export interface CleanResult { removed: string[]; skippedProtected: string[]; skippedRecent: string[] }

/**
 * Remove stale unit-test leftovers from a temp folder. Never removes: a protected-prefix entry, an entry newer than the age floor, or anything outside
 * the test-artifact prefixes. `createdSince` (optional) additionally limits removal to entries touched at/after a run start (used by test teardown).
 */
export function cleanTestArtifacts(tmpDir: string, policy: ArtifactPolicy, opts: { nowMs?: number; createdSinceMs?: number; idleMs?: number; dryRun?: boolean } = {}): CleanResult {
  const now = opts.nowMs ?? Date.now();
  const res: CleanResult = { removed: [], skippedProtected: [], skippedRecent: [] };
  for (const name of fs.readdirSync(tmpDir)) {
    if (!policy.testArtifactPrefixes.some((p) => name.startsWith(p))) continue;
    if (isProtectedArtifact(name, policy)) { res.skippedProtected.push(name); continue; }
    const full = path.join(tmpDir, name);
    let mtime: number;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    // teardown: only this run's leftovers, and only ones idle for a while - a concurrent suite's ACTIVE databases are modified continuously and must survive
    if (opts.createdSinceMs !== undefined) { if (mtime < opts.createdSinceMs || now - mtime < (opts.idleMs ?? 120_000)) continue; }
    else if (now - mtime < policy.testArtifactMaxAgeMinutes * 60_000) { res.skippedRecent.push(name); continue; }
    if (!opts.dryRun) { try { fs.rmSync(full, { recursive: true, force: true }); } catch { continue; } }
    res.removed.push(name);
  }
  return res;
}

export function defaultTmpDir(): string { return os.tmpdir(); }
