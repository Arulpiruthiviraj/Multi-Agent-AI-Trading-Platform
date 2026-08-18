/**
 * ==========================================================
 * Module: strategiesEngine/registry/StrategyRegistry
 *
 * Purpose:
 * In-memory registry/catalog for StrategyDefinitions (Section 11). Independent from trading
 * execution - this class has no knowledge of EventBus, brokers, or order placement, and nothing
 * in the live decision path holds a reference to an instance of it. A definition is only accepted
 * by `register()` if validateStrategy() reports it valid.
 * ==========================================================
 */
import { StrategyDefinition, StrategyFamily } from '../core/types';
import { validateStrategy } from '../validation/validateStrategy';

export interface StrategySearchCriteria {
  family?: StrategyFamily;
  tag?: string;
  implementationStatus?: StrategyDefinition['implementationStatus'];
  origin?: StrategyDefinition['metadata']['origin'];
  namePattern?: RegExp;
}

export class DuplicateStrategyError extends Error {
  constructor(id: string) {
    super(`Strategy '${id}' is already registered - register() never silently overwrites. Use version()/bumpVersion() for an intentional update.`);
    this.name = 'DuplicateStrategyError';
  }
}

export class InvalidStrategyError extends Error {
  constructor(id: string, messages: string[]) {
    super(`Strategy '${id}' failed validation: ${messages.join('; ')}`);
    this.name = 'InvalidStrategyError';
  }
}

export class StrategyRegistry {
  private byId = new Map<string, StrategyDefinition>();
  private byFamily = new Map<StrategyFamily, Set<string>>();
  private byTag = new Map<string, Set<string>>();
  /** All known versions of a given (family, name) lineage, newest last. */
  private lineages = new Map<string, string[]>();

  register(strategy: StrategyDefinition): StrategyDefinition {
    const result = validateStrategy(strategy);
    if (!result.valid) {
      throw new InvalidStrategyError(strategy.id, result.errors.map(e => `${e.path}: ${e.message}`));
    }
    if (this.byId.has(strategy.id)) {
      throw new DuplicateStrategyError(strategy.id);
    }

    this.byId.set(strategy.id, strategy);

    if (!this.byFamily.has(strategy.family)) this.byFamily.set(strategy.family, new Set());
    this.byFamily.get(strategy.family)!.add(strategy.id);

    for (const tag of strategy.metadata.tags) {
      if (!this.byTag.has(tag)) this.byTag.set(tag, new Set());
      this.byTag.get(tag)!.add(strategy.id);
    }

    const lineageKey = `${strategy.family}:${strategy.name}`;
    if (!this.lineages.has(lineageKey)) this.lineages.set(lineageKey, []);
    this.lineages.get(lineageKey)!.push(strategy.id);

    return strategy;
  }

  registerMany(strategies: StrategyDefinition[]): { registered: StrategyDefinition[]; skipped: Array<{ id: string; reason: string }> } {
    const registered: StrategyDefinition[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const s of strategies) {
      try {
        registered.push(this.register(s));
      } catch (e) {
        skipped.push({ id: s.id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { registered, skipped };
  }

  get(id: string): StrategyDefinition | undefined {
    return this.byId.get(id);
  }

  exists(id: string): boolean {
    return this.byId.has(id);
  }

  remove(id: string): boolean {
    const strategy = this.byId.get(id);
    if (!strategy) return false;
    this.byId.delete(id);
    this.byFamily.get(strategy.family)?.delete(id);
    for (const tag of strategy.metadata.tags) this.byTag.get(tag)?.delete(id);
    return true;
  }

  getByFamily(family: StrategyFamily): StrategyDefinition[] {
    const ids = this.byFamily.get(family);
    if (!ids) return [];
    return Array.from(ids).map(id => this.byId.get(id)!).filter(Boolean);
  }

  getByTag(tag: string): StrategyDefinition[] {
    const ids = this.byTag.get(tag);
    if (!ids) return [];
    return Array.from(ids).map(id => this.byId.get(id)!).filter(Boolean);
  }

  /** All registered versions of the (family, name) lineage `strategy` belongs to, oldest first. */
  versions(strategy: Pick<StrategyDefinition, 'family' | 'name'>): StrategyDefinition[] {
    const ids = this.lineages.get(`${strategy.family}:${strategy.name}`) ?? [];
    return ids.map(id => this.byId.get(id)!).filter(Boolean).sort((a, b) => a.version - b.version);
  }

  search(criteria: StrategySearchCriteria): StrategyDefinition[] {
    let pool = this.listAll();
    if (criteria.family) pool = pool.filter(s => s.family === criteria.family);
    if (criteria.tag) pool = pool.filter(s => s.metadata.tags.includes(criteria.tag!));
    if (criteria.implementationStatus) pool = pool.filter(s => s.implementationStatus === criteria.implementationStatus);
    if (criteria.origin) pool = pool.filter(s => s.metadata.origin === criteria.origin);
    if (criteria.namePattern) pool = pool.filter(s => criteria.namePattern!.test(s.name));
    return pool;
  }

  listAll(): StrategyDefinition[] {
    return Array.from(this.byId.values());
  }

  count(): number {
    return this.byId.size;
  }

  listFamilies(): StrategyFamily[] {
    return Array.from(this.byFamily.keys());
  }

  clear(): void {
    this.byId.clear();
    this.byFamily.clear();
    this.byTag.clear();
    this.lineages.clear();
  }
}
