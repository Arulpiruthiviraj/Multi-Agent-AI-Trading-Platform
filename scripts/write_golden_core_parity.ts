/**
 * Fill fixtures/research/golden_core_parity.json expectedTsVector from live TS engines.
 * UNIT_FIXTURE only. Does not invent market data or an edge.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreParityVector } from '../src/server/research/coreParityVectors';
import type { ResearchBar } from '../src/server/research/ohlcvTypes';

const bars: ResearchBar[] = Array.from({ length: 40 }, (_, i) => ({
  timestamp: i * 86400000,
  open: 100 + i * 0.1,
  high: 101 + i * 0.1,
  low: 99 + i * 0.1,
  close: 100.5 + i * 0.1,
  volume: i === 39 ? 40 : 10,
}));

const expectedTsVector = coreParityVector(bars);
const out = {
  $comment: 'UNIT_FIXTURE for CORE BOS/RVOL/Keltner/S-R vector parity. Not REAL_MARKET_DATA. Not an edge.',
  provenance: 'UNIT_FIXTURE',
  fullStrategyParity: false,
  parityScope: ['structureEvent', 'structureTrend', 'rvol', 'keltner', 'nearestSupport', 'nearestResistance'],
  bars,
  expectedTsVector,
};
const path = join(process.cwd(), 'fixtures', 'research', 'golden_core_parity.json');
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, path, expectedTsVector, canPlaceOrders: false }));
