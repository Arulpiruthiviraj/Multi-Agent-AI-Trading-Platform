/**
 * ARGUS Crypto V2 - isolated synthetic experiment registry (2026-09-21). Real, persisted,
 * reproducibility-tracking records for synthetic population runs - deliberately a plain
 * append-only JSON-lines FILE, not a second SQLite schema wired through better-sqlite3/Drizzle,
 * to avoid any risk of accidentally sharing a driver/connection pattern with the production
 * database module (src/server/db/index.ts, which this directory's architecture boundary test
 * already forbids importing). Every write path is guarded by assertSyntheticArtifactPath()
 * (production-pollution guard) so a call with any path outside data/argus-synthetic/ fails loudly
 * rather than silently writing somewhere unintended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertSyntheticArtifactPath } from './productionPollutionGuard';

export interface SyntheticExperimentRecord {
  experimentId: string;
  populationSeed: number;
  scenarioSeed: number | null;
  assetCount: number;
  totalBars: number;
  startedAtMs: number;
  finishedAtMs: number;
  /** Free-form, real, caller-supplied summary numbers (e.g. wall-clock ms, memory delta,
   *  regime distribution counts) - never a fabricated performance claim, just whatever the
   *  caller actually measured. */
  resultSummary: Record<string, number | string>;
  status: 'RESEARCH_ONLY' | 'SCALE_TEST' | 'ADVERSARIAL' | 'MONTE_CARLO';
}

const DEFAULT_REGISTRY_PATH = path.join('data', 'argus-synthetic', 'experiments', 'registry.jsonl');

export function recordExperiment(record: SyntheticExperimentRecord, registryPath: string = DEFAULT_REGISTRY_PATH): void {
  assertSyntheticArtifactPath(registryPath);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.appendFileSync(registryPath, JSON.stringify(record) + '\n', 'utf8');
}

export function readAllExperiments(registryPath: string = DEFAULT_REGISTRY_PATH): SyntheticExperimentRecord[] {
  assertSyntheticArtifactPath(registryPath);
  if (!fs.existsSync(registryPath)) return [];
  const content = fs.readFileSync(registryPath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SyntheticExperimentRecord);
}
