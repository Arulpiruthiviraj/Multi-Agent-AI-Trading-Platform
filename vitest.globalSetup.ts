/**
 * Vitest global teardown (2026-10-14): remove this run's idle unit-test temp databases so repeated suites cannot fill the drive (18,000 leftover files /
 * ~40 GB on Oct 14). Policy in config/syntheticArtifacts.json; protected evidence prefixes are never removed; only files created since this run started
 * AND idle for a while are removed so a concurrently running suite or certification session is never disturbed.
 */
import os from 'node:os';
import { cleanTestArtifacts, loadArtifactPolicy } from './scripts/sim/artifactLifecycle';

export default function setup(): () => void {
  const startedAt = Date.now();
  return () => {
    try { cleanTestArtifacts(os.tmpdir(), loadArtifactPolicy(), { createdSinceMs: startedAt }); } catch { /* cleanup is best effort and must never fail the run */ }
  };
}
