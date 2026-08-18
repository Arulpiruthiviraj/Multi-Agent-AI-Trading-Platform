/**
 * Durable research-run artifacts. Disk writes are opt-in (ARGUS_WRITE_RESEARCH_PARQUET=true).
 * Promotion reads these objects — never invented booleans.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';
import { researchDataDir } from './parquetStore';
import type { StrategyEvidence } from './promotionEngine';

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
      strategyId: result.strategyId,
      strategyVersion: result.strategyVersion,
      datasetId: result.datasetId,
      datasetHash: result.datasetHash,
      executionModel: result.executionModel,
      executionModelVersion: result.executionModelVersion,
      costModel: result.costModel,
      provenance: result.provenance,
      quality: result.quality,
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

/** Persist WFO/robustness gate snapshot beside a research run (opt-in disk). Never invents PASS. */
export function recordEvidenceGates(
  runId: string,
  gates: Record<string, unknown>,
): void {
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') return;
  const dir = join(researchDataDir(), 'runs', runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'evidence_gates.json'), JSON.stringify({
    ...gates,
    promotable: false,
    live: 'NO-GO',
    canPlaceOrders: false,
    recordedAt: new Date().toISOString(),
  }, null, 2));
}

/** Persist the CORE baseline evidence index used by strategyEvidence loaders. */
export function persistBaselineEvidenceIndex(
  entries: Array<{
    strategyId: string;
    runId: string;
    evidence: StrategyEvidence;
    gateSnapshot: Record<string, unknown>;
  }>,
): string | null {
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') return null;
  const dir = join(researchDataDir(), 'runs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, 'baseline_index.json');
  const payload = {
    createdAt: new Date().toISOString(),
    executionModelRequired: 'NEXT_BAR_OPEN',
    qualityStatusRequired: 'GREEN',
    parquetBytesWrittenRequired: true,
    promotable: false,
    live: 'NO-GO',
    canPlaceOrders: false,
    strategies: entries.map((e) => ({
      strategyId: e.strategyId,
      runId: e.runId,
      evidence: e.evidence,
      gateSnapshot: e.gateSnapshot,
    })),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  for (const e of entries) {
    const stratDir = join(dir, 'baseline', e.strategyId);
    if (!existsSync(stratDir)) mkdirSync(stratDir, { recursive: true });
    writeFileSync(join(stratDir, 'evidence.json'), JSON.stringify({
      ...e.evidence,
      runId: e.runId,
      gateSnapshot: e.gateSnapshot,
      promotable: false,
      live: 'NO-GO',
    }, null, 2));
  }
  return path;
}

export function loadBaselineEvidenceIndex(): {
  createdAt: string;
  strategies: Array<{ strategyId: string; runId: string; evidence: StrategyEvidence; gateSnapshot: Record<string, unknown> }>;
} | null {
  const path = join(researchDataDir(), 'runs', 'baseline_index.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      createdAt?: string;
      strategies?: Array<{ strategyId: string; runId: string; evidence: StrategyEvidence; gateSnapshot: Record<string, unknown> }>;
    };
    if (!Array.isArray(raw.strategies)) return null;
    return { createdAt: raw.createdAt ?? '', strategies: raw.strategies };
  } catch {
    return null;
  }
}

export function loadPersistedEvidenceForStrategy(strategyId: string): StrategyEvidence | null {
  const baselinePath = join(researchDataDir(), 'runs', 'baseline', strategyId, 'evidence.json');
  if (existsSync(baselinePath)) {
    try {
      const raw = JSON.parse(readFileSync(baselinePath, 'utf8')) as StrategyEvidence & { runId?: string };
      if (raw && raw.strategyId === strategyId) return raw;
    } catch {
      // fall through
    }
  }
  const index = loadBaselineEvidenceIndex();
  const hit = index?.strategies.find((s) => s.strategyId === strategyId);
  return hit?.evidence ?? null;
}

export function latestRunForStrategy(strategyId: string): ResearchRunRecord | null {
  let best: ResearchRunRecord | null = null;
  for (const rec of memory.values()) {
    if (rec.manifest.strategyId !== strategyId) continue;
    if (!best || rec.manifest.createdAt > best.manifest.createdAt) best = rec;
  }
  // Disk fallback: newest runs/*/manifest.json with matching strategyId
  if (!best) {
    const runsDir = join(researchDataDir(), 'runs');
    if (existsSync(runsDir)) {
      for (const name of readdirSync(runsDir)) {
        const manifestPath = join(runsDir, name, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as CanonicalBacktestResult & { runId?: string };
          if (m.strategyId !== strategyId) continue;
          // Real bug fix: recordResearchRun() above deliberately writes `metrics`/`trades` to their
          // OWN sibling files (metrics.json/trades.json), not into manifest.json - manifest.json is
          // a real, intentionally-trimmed summary. This disk-fallback path used to cast the trimmed
          // manifest.json directly as a full CanonicalBacktestResult and hand it to callers like
          // reconcilePaperVsResearch(), which unconditionally reads `.metrics.expectancy` - a real,
          // reproducing crash (TypeError: Cannot read properties of undefined) any time a research
          // run only exists on disk (not in the in-memory `memory` map from this same process).
          // Read the sibling files back in and merge, so this reconstructs the SAME real object
          // recordResearchRun() was given, not a partial one.
          const metricsPath = join(runsDir, name, 'metrics.json');
          const tradesPath = join(runsDir, name, 'trades.json');
          if (existsSync(metricsPath)) {
            try { m.metrics = JSON.parse(readFileSync(metricsPath, 'utf8')); } catch { /* leave whatever manifest.json had, if anything */ }
          }
          if (existsSync(tradesPath)) {
            try { m.trades = JSON.parse(readFileSync(tradesPath, 'utf8')); } catch { /* leave whatever manifest.json had, if anything */ }
          }
          const rec: ResearchRunRecord = { runId: m.runId || name, manifest: m as CanonicalBacktestResult };
          if (!best || rec.manifest.createdAt > best.manifest.createdAt) best = rec;
        } catch {
          // skip
        }
      }
    }
  }
  return best;
}

export function listResearchRuns(): ResearchRunRecord[] {
  return [...memory.values()];
}
