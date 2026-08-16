/**
 * ==========================================================
 * Module: config/quantStrategyTaxonomy
 *
 * Purpose:
 * Load config/quantStrategyTaxonomy.json (760 aliases) and config/quantMasterTaxonomy.json
 * (10 families). Catalog only — not 1,000 evaluate() functions and not a live-path change.
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

export interface MasterArchetype {
  id: string;
  name: string;
  status: TaxonomyStatus;
  moduleId?: string;
  implementationNote?: string;
  reason?: string;
  edgeHypothesis: string;
  invalidation: string;
}

export interface MasterFamily {
  id: string;
  name: string;
  premise: string;
  archetypes: MasterArchetype[];
}

export interface QuantMasterTaxonomyConfig {
  note: string;
  families: MasterFamily[];
}

function loadMasterTaxonomy(): QuantMasterTaxonomyConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('quantMasterTaxonomy.json');
  if (typeof raw.note !== 'string' || !raw.note) {
    throw new Error('config/quantMasterTaxonomy.json missing note');
  }
  if (!Array.isArray(raw.families) || raw.families.length !== 10) {
    throw new Error('config/quantMasterTaxonomy.json must have exactly 10 families');
  }
  const families: MasterFamily[] = [];
  for (const item of raw.families) {
    if (!item || typeof item !== 'object') {
      throw new Error('config/quantMasterTaxonomy.json families[] entry is not an object');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) {
      throw new Error('config/quantMasterTaxonomy.json family missing id');
    }
    if (typeof row.name !== 'string' || !row.name) {
      throw new Error(`config/quantMasterTaxonomy.json family ${row.id} missing name`);
    }
    if (typeof row.premise !== 'string' || !row.premise) {
      throw new Error(`config/quantMasterTaxonomy.json family ${row.id} missing premise`);
    }
    if (!Array.isArray(row.archetypes) || row.archetypes.length === 0) {
      throw new Error(`config/quantMasterTaxonomy.json family ${row.id} missing archetypes[]`);
    }
    const archetypes: MasterArchetype[] = [];
    for (const arch of row.archetypes) {
      if (!arch || typeof arch !== 'object') {
        throw new Error(`config/quantMasterTaxonomy.json family ${row.id} archetype is not an object`);
      }
      const t = arch as Record<string, unknown>;
      if (typeof t.id !== 'string' || !t.id) {
        throw new Error(`config/quantMasterTaxonomy.json family ${row.id} archetype missing id`);
      }
      if (typeof t.name !== 'string' || !t.name) {
        throw new Error(`config/quantMasterTaxonomy.json ${t.id} missing name`);
      }
      if (typeof t.status !== 'string' || !STATUSES.has(t.status as TaxonomyStatus)) {
        throw new Error(`config/quantMasterTaxonomy.json ${t.id} has invalid status`);
      }
      if (typeof t.edgeHypothesis !== 'string' || !t.edgeHypothesis) {
        throw new Error(`config/quantMasterTaxonomy.json ${t.id} missing edgeHypothesis`);
      }
      if (typeof t.invalidation !== 'string' || !t.invalidation) {
        throw new Error(`config/quantMasterTaxonomy.json ${t.id} missing invalidation`);
      }
      const status = t.status as TaxonomyStatus;
      if (status === 'NOT_SUPPORTED') {
        if (typeof t.reason !== 'string' || !t.reason) {
          throw new Error(`config/quantMasterTaxonomy.json ${t.id} NOT_SUPPORTED missing reason`);
        }
        archetypes.push({
          id: t.id, name: t.name, status, reason: t.reason,
          edgeHypothesis: t.edgeHypothesis, invalidation: t.invalidation,
        });
      } else {
        if (typeof t.moduleId !== 'string' || !t.moduleId) {
          throw new Error(`config/quantMasterTaxonomy.json ${t.id} missing moduleId`);
        }
        if (typeof t.implementationNote !== 'string' || !t.implementationNote) {
          throw new Error(`config/quantMasterTaxonomy.json ${t.id} missing implementationNote`);
        }
        archetypes.push({
          id: t.id, name: t.name, status, moduleId: t.moduleId,
          implementationNote: t.implementationNote,
          edgeHypothesis: t.edgeHypothesis, invalidation: t.invalidation,
        });
      }
    }
    families.push({ id: row.id, name: row.name, premise: row.premise, archetypes });
  }
  return { note: raw.note, families };
}

export const quantMasterTaxonomy: QuantMasterTaxonomyConfig = loadMasterTaxonomy();

export function allMasterArchetypes(): MasterArchetype[] {
  return quantMasterTaxonomy.families.flatMap(f => f.archetypes);
}

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
  const archetypes = allMasterArchetypes();
  return {
    note: quantStrategyTaxonomy.note,
    masterNote: quantMasterTaxonomy.note,
    namedTechniqueCount: techniques.length,
    masterFamilyCount: quantMasterTaxonomy.families.length,
    masterArchetypeCount: archetypes.length,
    masterMappedCount: archetypes.filter(a => a.status !== 'NOT_SUPPORTED').length,
    masterNotSupportedCount: archetypes.filter(a => a.status === 'NOT_SUPPORTED').length,
    codedModuleCount: CORE_STRATEGIES.length + EXPERIMENTAL_STRATEGIES.length,
    taxonomyCodedModuleCount: coded.size,
    implementedAliasCount: techniques.filter(t => t.status !== 'NOT_SUPPORTED').length,
    notSupportedCount: techniques.filter(t => t.status === 'NOT_SUPPORTED').length,
    liveEvaluateAllRemainsCoreUnlessEnvFlag: true,
    masterFamilies: quantMasterTaxonomy.families.map(f => ({
      id: f.id,
      name: f.name,
      premise: f.premise,
      archetypeCount: f.archetypes.length,
      mappedCount: f.archetypes.filter(a => a.status !== 'NOT_SUPPORTED').length,
      notSupportedCount: f.archetypes.filter(a => a.status === 'NOT_SUPPORTED').length,
      archetypes: f.archetypes,
    })),
    families: quantStrategyTaxonomy.families.map(f => ({
      id: f.id,
      name: f.name,
      namedCount: f.techniques.length,
      notSupportedCount: f.techniques.filter(t => t.status === 'NOT_SUPPORTED').length,
      techniques: f.techniques,
    })),
  };
}
