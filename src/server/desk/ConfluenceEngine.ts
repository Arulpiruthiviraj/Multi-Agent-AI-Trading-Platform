/**
 * Confluence is not "RSI + MACD + SMA all BUY".
 * Independent groups from config/confluenceIndependence.json are counted once each.
 */
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

interface Group {
  id: string;
  weight: number;
  members: string[];
}

const file = loadRepoConfigJson<{ groups: Group[] }>('confluenceIndependence.json');

export interface ConfluenceResult {
  score: number | null;
  independentGroupsHit: string[];
  oscillatorCollapsed: boolean;
  note: string;
  source: string;
}

export function scoreConfluence(flags: {
  hasStructure: boolean;
  hasVolume: boolean;
  hasVwap: boolean;
  hasIndex: boolean;
  hasSector: boolean;
  hasCatalyst: boolean;
  hasFavorableRr: boolean;
  hasCleanInvalidation: boolean;
  oscillatorBuyCount: number;
}): ConfluenceResult {
  const hits: string[] = [];
  if (flags.hasStructure) hits.push('structure');
  if (flags.hasVolume || flags.hasVwap) hits.push('volume');
  if (flags.hasIndex || flags.hasSector) hits.push('context');
  if (flags.hasCatalyst) hits.push('catalyst');
  if (flags.hasFavorableRr || flags.hasCleanInvalidation) hits.push('risk');
  const oscillatorCollapsed = flags.oscillatorBuyCount > 1;
  if (flags.oscillatorBuyCount > 0) hits.push('oscillators');

  const unique = [...new Set(hits)];
  let weighted = 0;
  let denom = 0;
  for (const g of file.groups) {
    denom += g.weight;
    if (unique.includes(g.id)) weighted += g.weight;
  }
  const score = denom > 0 ? Math.round((weighted / denom) * 100) : null;
  return {
    score,
    independentGroupsHit: unique,
    oscillatorCollapsed,
    note: oscillatorCollapsed
      ? 'Oscillators collapsed into one group so RSI+MACD+SMA cannot triple-count.'
      : 'Independent groups weighted from confluenceIndependence.json. Not a win probability.',
    source: 'config/confluenceIndependence.json',
  };
}
