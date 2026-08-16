/**
 * Assert CORE BOS/RVOL/Keltner/S-R vectors match between TS engines and the Python translation.
 * Does not invent an edge. Spawns VectorBT CLI only when ARGUS_TEST_ALLOW_VECTORBT=true.
 */
import { coreParityVector, nextOpenFillStats, vectorsMatch } from '../src/server/research/coreParityVectors';
import { compareEngines, runResearchCli } from '../src/server/research/VectorBTService';
import type { ResearchBar } from '../src/server/research/ohlcvTypes';

const bars: ResearchBar[] = Array.from({ length: 40 }, (_, i) => ({
  timestamp: i * 86400000,
  open: 100 + i * 0.1,
  high: 101 + i * 0.1,
  low: 99 + i * 0.1,
  close: 100.5 + i * 0.1,
  volume: i === 39 ? 40 : 10,
}));

async function main() {
  const ts = coreParityVector(bars);
  const buys = bars.map((_, i) => i % 8 === 0);
  const tsFills = nextOpenFillStats(bars, buys);
  const sameFills = nextOpenFillStats(bars, buys);
  const fillCmp = compareEngines(tsFills, sameFills);
  if (fillCmp.status !== 'PASS') {
    console.error(JSON.stringify({ ok: false, error: 'ENGINE_MISMATCH', fillCmp, note: 'identical TS fills must match' }));
    process.exit(1);
  }
  if (process.env.ARGUS_TEST_ALLOW_VECTORBT !== 'true') {
    console.log(JSON.stringify({
      ok: true,
      pythonCompared: false,
      tsVector: ts,
      fillCmp,
      note: 'Set ARGUS_TEST_ALLOW_VECTORBT=true to compare Python core_features.py. Zero ENGINE_MISMATCH on identical NEXT_BAR_OPEN fills.',
    }));
    return;
  }
  const py = await runResearchCli({ job: 'core_feature_parity', bars }) as any;
  if (!py?.ok || !py.vector) {
    console.error(JSON.stringify({ ok: false, error: 'python_unavailable', py }));
    process.exit(1);
  }
  const match = vectorsMatch(ts, py.vector);
  if (!match) {
    console.error(JSON.stringify({ ok: false, error: 'ENGINE_MISMATCH', ts, python: py.vector }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, pythonCompared: true, status: 'PASS', ts, python: py.vector, canPlaceOrders: false }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
