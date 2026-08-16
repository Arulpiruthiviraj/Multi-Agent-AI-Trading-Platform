/**
 * Durable research-run artifacts. Disk writes are opt-in (ARGUS_WRITE_RESEARCH_PARQUET=true).
 * Promotion reads these objects — never invented booleans.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';
import { researchDataDir } from './parquetStore';

export interface ResearchRunRecord {
  runId: string;
  manifest: CanonicalBacktestResult;
}

const memory = new Map<string, ResearchRunRecord>();

export function recordResearchRun(result: CanonicalBacktestResult): ResearchRunRecord {
  const runId = createHash('sha256')
    .update(`${result.strategyVersion}|${result.datasetHash}|${result.createdAt}|${result.strategyId}`)
    .digest('hex')
    .slice(0, 16);
  const rec: ResearchRunRecord = { runId, manifest: result };
  memory.set(runId, rec);
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET === 'true') {
    const dir = join(researchDataDir(), 'runs', runId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      runId,
      engine: result.engine,
      strategyVersion: result.strategyVersion,
      datasetHash: result.datasetHash,
      executionModel: result.executionModel,
      executionModelVersion: result.executionModelVersion,
      costModel: result.costModel,
      provenance: result.provenance,
      backtestPass: result.backtestPass,
      rejection: result.rejection,
      canPlaceOrders: false,
      comparableToSameBarClose: false,
    }, null, 2));
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(result.metrics, null, 2));
    writeFileSync(join(dir, 'trades.json'), JSON.stringify(result.trades, null, 2));
    writeFileSync(join(dir, 'promotion.json'), JSON.stringify({
      promotable: false,
      backtestPass: result.backtestPass,
      live: 'NO-GO',
    }, null, 2));
  }
  return rec;
}

export function latestRunForStrategy(strategyId: string): ResearchRunRecord | null {
  let best: ResearchRunRecord | null = null;
  for (const rec of memory.values()) {
    if (rec.manifest.strategyId !== strategyId) continue;
    if (!best || rec.manifest.createdAt > best.manifest.createdAt) best = rec;
  }
  return best;
}

export function listResearchRuns(): ResearchRunRecord[] {
  return [...memory.values()];
}
