import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalDataset } from './ohlcvTypes';

export function loadGoldenSmaDataset(): CanonicalDataset {
  const candidates = [
    join(process.cwd(), 'fixtures', 'research', 'golden_sma.json'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/research/golden_sma.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return { ...JSON.parse(readFileSync(p, 'utf8')), provenance: 'UNIT_FIXTURE' } as CanonicalDataset;
    }
  }
  throw new Error('fixtures/research/golden_sma.json not found');
}
