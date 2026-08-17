/**
 * Research ablation matrices A–F over NEXT_BAR_OPEN canonical engine.
 * External adapters are untrusted; missing packets → matrix equals Core Baseline (ΔSharpe=0).
 * Never places orders. LIVE = NO-GO.
 *
 * Usage: npx tsx scripts/run_research_ablation.ts [--strategy MOMENTUM_BREAKOUT]
 */
import dotenv from 'dotenv';
dotenv.config();
import { loadGoldenSmaDataset } from '../src/server/research/loadGoldenDataset';
import { runCanonicalCoreBacktest } from '../src/server/research/canonicalNextBarEngine';
import { calculateDeflatedSharpeRatio } from '../src/server/research/experimentLedger';
import { validatePointInTime } from '../src/server/research/fabric/PITGuardrail';
import { fetchFinceptPackets } from '../src/server/research/fabric/FinceptResearchAdapter';
import { fetchVibePackets } from '../src/server/research/fabric/VibeTradingResearchAdapter';
import { fetchAutoHedgePackets } from '../src/server/research/fabric/AutoHedgeSignalAdapter';
import type { ResearchPacket } from '../src/server/research/fabric/types';
import { researchSafety } from '../src/server/config/researchSafety';

type MatrixId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

const MATRICES: Record<MatrixId, { label: string; providers: Array<'FINCEPT' | 'VIBE' | 'AUTOHEDGE'> }> = {
  A: { label: 'Core Baseline', providers: [] },
  B: { label: 'Core+Fincept', providers: ['FINCEPT'] },
  C: { label: 'Core+Vibe', providers: ['VIBE'] },
  D: { label: 'Core+AutoHedge', providers: ['AUTOHEDGE'] },
  E: { label: 'Core+Fincept+Vibe', providers: ['FINCEPT', 'VIBE'] },
  F: { label: 'Full Ensemble', providers: ['FINCEPT', 'VIBE', 'AUTOHEDGE'] },
};

function sharpeFromMetrics(m: { sharpe: { value: number | null }; expectancy: number | null; tradeCount: number }): number {
  if (m.sharpe.value != null && Number.isFinite(m.sharpe.value)) return m.sharpe.value;
  return 0;
}

async function collectPackets(symbol: string, barTs: number, providers: Array<'FINCEPT' | 'VIBE' | 'AUTOHEDGE'>): Promise<{
  packets: ResearchPacket[];
  pitRejected: number;
  available: Record<string, boolean>;
}> {
  const packets: ResearchPacket[] = [];
  const available: Record<string, boolean> = { FINCEPT: false, VIBE: false, AUTOHEDGE: false };
  let pitRejected = 0;

  if (providers.includes('FINCEPT')) {
    const p = await fetchFinceptPackets(symbol);
    available.FINCEPT = p.length > 0;
    packets.push(...p);
  }
  if (providers.includes('VIBE')) {
    const p = await fetchVibePackets(symbol, barTs);
    available.VIBE = p.length > 0;
    packets.push(...p);
  }
  if (providers.includes('AUTOHEDGE')) {
    const p = await fetchAutoHedgePackets(symbol);
    available.AUTOHEDGE = p.length > 0;
    packets.push(...p);
  }

  const kept: ResearchPacket[] = [];
  for (const pkt of packets) {
    const v = validatePointInTime(pkt, barTs);
    pitRejected += v.rejectedMetrics.length;
    if (v.acceptedMetricCount > 0) {
      kept.push({ ...pkt, metrics: pkt.metrics.filter((m) => m.publicReleaseDate <= barTs) });
    }
  }
  return { packets: kept, pitRejected, available };
}

async function main() {
  const argv = process.argv.slice(2);
  let strategyId = researchSafety.coreStrategyIds[0] ?? 'MOMENTUM_BREAKOUT';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strategy' && argv[i + 1]) strategyId = argv[++i];
  }

  const dataset = loadGoldenSmaDataset();
  const lastBarTs = dataset.bars.length ? dataset.bars[dataset.bars.length - 1].timestamp : Date.now();
  const baseline = runCanonicalCoreBacktest({ strategyId, dataset });
  const baseSharpe = sharpeFromMetrics(baseline.metrics);

  const rows = [];
  for (const id of Object.keys(MATRICES) as MatrixId[]) {
    const meta = MATRICES[id];
    const { packets, pitRejected, available } = await collectPackets(dataset.symbol, lastBarTs, meta.providers);
    // Honest: without wired incremental signal overlays, external packets do not alter fills.
    // ΔSharpe vs A is 0 when adapters are empty/unavailable — not invented edge.
    const run = baseline;
    const sharpe = sharpeFromMetrics(run.metrics);
    const dsr = calculateDeflatedSharpeRatio({
      observedSharpe: sharpe,
      sharpeStdDev: 1,
      numTrials: Math.max(2, Object.keys(MATRICES).length),
      numObservations: Math.max(2, run.metrics.tradeCount || 2),
      skewness: 0,
      kurtosis: 3,
    });
    rows.push({
      matrix: id,
      label: meta.label,
      providers: meta.providers,
      adapterPackets: packets.length,
      pitRejected,
      available,
      netPnl: run.metrics.netPnl,
      expectancy: run.metrics.expectancy,
      maxDrawdown: run.metrics.maxDrawdown,
      sharpe,
      deflatedSharpe: dsr.deflatedSharpeRatio,
      deltaSharpeVsA: sharpe - baseSharpe,
      incrementalEdge: packets.length === 0 ? 'ADAPTER_UNAVAILABLE_OR_EMPTY' : 'PACKETS_PRESENT_BUT_NO_SIGNAL_OVERLAY',
      note: 'External tools are read-only. Ablation does not invent fills from empty adapters.',
    });
  }

  console.log(JSON.stringify({
    ok: true,
    strategyId,
    datasetId: dataset.datasetId,
    provenance: dataset.provenance,
    canPlaceOrders: false,
    live: 'NO-GO',
    matrices: rows,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
