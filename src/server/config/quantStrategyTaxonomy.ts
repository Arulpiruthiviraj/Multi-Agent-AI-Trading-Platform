/**
 * ==========================================================
 * Module: config/quantStrategyTaxonomy
 *
 * Purpose:
 * Load config/quantStrategyTaxonomy.json: named techniques (the 700+ alias list) mapped to
 * CORE / EXPERIMENTAL modules or honest NOT_SUPPORTED. This is a catalog, not 1,000 evaluate()
 * functions and not a live-path change. Missing required keys fail boot.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { CORE_STRATEGIES, EXPERIMENTAL_STRATEGIES } from '../quant/strategies/StrategyEngine';

export type TaxonomyStatus = 'CORE' | 'EXPERIMENTAL' | 'NOT_SUPPORTED';

export interface TaxonomyTechnique {
  n: number;
  name: string;
  status: TaxonomyStatus;
  moduleId?: string;
  reason?: string;
}

export interface TaxonomyFamily {
  id: string;
  name: string;
  techniques: TaxonomyTechnique[];
}

export interface QuantStrategyTaxonomyConfig {
  note: string;
  families: TaxonomyFamily[];
}

const STATUSES = new Set<TaxonomyStatus>(['CORE', 'EXPERIMENTAL', 'NOT_SUPPORTED']);

function loadTaxonomy(): QuantStrategyTaxonomyConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('quantStrategyTaxonomy.json');
  if (typeof raw.note !== 'string' || !raw.note) {
    throw new Error('config/quantStrategyTaxonomy.json missing note');
  }
  if (!Array.isArray(raw.families) || raw.families.length === 0) {
    throw new Error('config/quantStrategyTaxonomy.json missing families[]');
  }
  const families: TaxonomyFamily[] = [];
  for (const item of raw.families) {
    if (!item || typeof item !== 'object') {
      throw new Error('config/quantStrategyTaxonomy.json families[] entry is not an object');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) {
      throw new Error('config/quantStrategyTaxonomy.json family missing id');
    }
    if (typeof row.name !== 'string' || !row.name) {
      throw new Error(`config/quantStrategyTaxonomy.json family ${row.id} missing name`);
    }
    if (!Array.isArray(row.techniques) || row.techniques.length === 0) {
      throw new Error(`config/quantStrategyTaxonomy.json family ${row.id} missing techniques[]`);
    }
    const techniques: TaxonomyTechnique[] = [];
    for (const tech of row.techniques) {
      if (!tech || typeof tech !== 'object') {
        throw new Error(`config/quantStrategyTaxonomy.json family ${row.id} technique is not an object`);
      }
      const t = tech as Record<string, unknown>;
      if (typeof t.n !== 'number' || !Number.isFinite(t.n)) {
        throw new Error(`config/quantStrategyTaxonomy.json family ${row.id} technique missing n`);
      }
      if (typeof t.name !== 'string' || !t.name) {
        throw new Error(`config/quantStrategyTaxonomy.json family ${row.id} technique ${t.n} missing name`);
      }
      if (typeof t.status !== 'string' || !STATUSES.has(t.status as TaxonomyStatus)) {
        throw new Error(`config/quantStrategyTaxonomy.json ${t.name} has invalid status`);
      }
      const status = t.status as TaxonomyStatus;
      if (status === 'NOT_SUPPORTED') {
        if (typeof t.reason !== 'string' || !t.reason) {
          throw new Error(`config/quantStrategyTaxonomy.json ${t.name} NOT_SUPPORTED missing reason`);
        }
        techniques.push({ n: t.n, name: t.name, status, reason: t.reason });
      } else {
        if (typeof t.moduleId !== 'string' || !t.moduleId) {
          throw new Error(`config/quantStrategyTaxonomy.json ${t.name} missing moduleId`);
        }
        techniques.push({ n: t.n, name: t.name, status, moduleId: t.moduleId });
      }
    }
    families.push({ id: row.id, name: row.name, techniques });
  }
  return { note: raw.note, families };
}

export const quantStrategyTaxonomy: QuantStrategyTaxonomyConfig = loadTaxonomy();

export function allTaxonomyTechniques(): TaxonomyTechnique[] {
  return quantStrategyTaxonomy.families.flatMap(f => f.techniques);
}

export function codedModuleIdsFromTaxonomy(): string[] {
  const ids = new Set<string>();
  for (const t of allTaxonomyTechniques()) {
    if (t.moduleId) ids.add(t.moduleId);
  }
  return [...ids];
}

/** Compact payload for GET /api/v2/quant/strategies — not a live enablement switch. */
export function quantStrategyTaxonomySummary() {
  const techniques = allTaxonomyTechniques();
  const coded = new Set(codedModuleIdsFromTaxonomy());
  return {
    note: quantStrategyTaxonomy.note,
    namedTechniqueCount: techniques.length,
    codedModuleCount: CORE_STRATEGIES.length + EXPERIMENTAL_STRATEGIES.length,
    taxonomyCodedModuleCount: coded.size,
    implementedAliasCount: techniques.filter(t => t.status !== 'NOT_SUPPORTED').length,
    notSupportedCount: techniques.filter(t => t.status === 'NOT_SUPPORTED').length,
    families: quantStrategyTaxonomy.families.map(f => ({
      id: f.id,
      name: f.name,
      namedCount: f.techniques.length,
      notSupportedCount: f.techniques.filter(t => t.status === 'NOT_SUPPORTED').length,
      techniques: f.techniques,
    })),
  };
}
