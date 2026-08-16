/**
 * Counts research trials so best-of-N search cannot hide multiple-testing.
 * In-memory; optional disk when ARGUS_WRITE_RESEARCH_PARQUET=true.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchSafety } from '../config/researchSafety';
import { multipleTestingWarning } from './multipleTesting';
import { researchDataDir } from './parquetStore';

export interface ExperimentLedger {
  trials: number;
  byStrategy: Record<string, number>;
  lastDatasetHash: string | null;
}

const ledger: ExperimentLedger = { trials: 0, byStrategy: {}, lastDatasetHash: null };

function persist(): void {
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') return;
  const dir = researchDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'experiment_ledger.json'), JSON.stringify(ledger, null, 2));
}

export function recordExperimentTrial(strategyId: string, datasetHash: string): ExperimentLedger {
  ledger.trials += 1;
  ledger.byStrategy[strategyId] = (ledger.byStrategy[strategyId] ?? 0) + 1;
  ledger.lastDatasetHash = datasetHash;
  persist();
  return { ...ledger, byStrategy: { ...ledger.byStrategy } };
}

export function experimentLedgerSnapshot(): ExperimentLedger & ReturnType<typeof multipleTestingWarning> {
  return { ...ledger, byStrategy: { ...ledger.byStrategy }, ...multipleTestingWarning(ledger.trials) };
}

export function loadLedgerFromDiskIfPresent(): void {
  const p = join(researchDataDir(), 'experiment_ledger.json');
  if (!existsSync(p)) return;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ExperimentLedger;
    ledger.trials = Number(raw.trials ?? 0);
    ledger.byStrategy = raw.byStrategy ?? {};
    ledger.lastDatasetHash = raw.lastDatasetHash ?? null;
  } catch {
    /* corrupt ledger is not fabricated evidence */
  }
}

export function minWalkForwardWindows(): number {
  return researchSafety.minWalkForwardWindows;
}
