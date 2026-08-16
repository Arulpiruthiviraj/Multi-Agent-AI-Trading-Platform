import { fixtureJsonCandidates, readFirstExistingJson } from '../config/repoPaths';
import type { CanonicalDataset } from './ohlcvTypes';

export function loadGoldenSmaDataset(): CanonicalDataset {
  const ds = readFirstExistingJson<CanonicalDataset>(
    fixtureJsonCandidates('fixtures', 'research', 'golden_sma.json'),
    'fixtures/research/golden_sma.json',
  );
  return { ...ds, provenance: 'UNIT_FIXTURE' };
}
