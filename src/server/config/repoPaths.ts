/**
 * Resolve repo JSON without the ESM import-meta URL helper.
 * The production bundle is CJS (`dist/server.cjs`); that bundle used to warn when those helpers
 * were inlined. Dev, vitest, and `npm run start` run with cwd = the repo root (or ARGUS_REPO_ROOT).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function repoRoot(): string {
  return process.env.ARGUS_REPO_ROOT || process.cwd();
}

export function firstExistingFile(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function readFirstExistingJson<T>(candidates: string[], label: string): T {
  const hit = firstExistingFile(candidates);
  if (!hit) {
    throw new Error(`${label} not found. Tried: ${candidates.join('; ')}`);
  }
  return JSON.parse(readFileSync(hit, 'utf8')) as T;
}

export function configJsonCandidates(fileName: string): string[] {
  return [join(repoRoot(), 'config', fileName)];
}

export function fixtureJsonCandidates(...segments: string[]): string[] {
  return [join(repoRoot(), ...segments)];
}
