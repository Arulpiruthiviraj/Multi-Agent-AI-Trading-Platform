import { createHash } from 'node:crypto';
import { researchSafety } from '../config/researchSafety';

export interface PaperExperimentSpec {
  experimentId: string;
  version: number;
  capital: number;
  universe: string[];
  timeframe: string;
  strategies: string[];
  ai: 'advisory';
  quant: 'controlled';
  execution: 'InternalPaperBroker';
  frozenHash: string;
}

export function createPaperExperiment(opts: {
  experimentId: string;
  version?: number;
  capital: number;
  universe: string[];
  timeframe: string;
}): PaperExperimentSpec {
  const strategies = [...researchSafety.coreStrategyIds];
  const version = opts.version ?? 1;
  const payload = {
    experimentId: opts.experimentId,
    version,
    capital: opts.capital,
    universe: opts.universe,
    timeframe: opts.timeframe,
    strategies,
    ai: 'advisory' as const,
    quant: 'controlled' as const,
    execution: 'InternalPaperBroker' as const,
  };
  const frozenHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, frozenHash };
}

export function experimentChangeRequiresNewVersion(
  a: PaperExperimentSpec,
  b: { experimentId: string; capital: number; universe: string[]; timeframe: string },
): boolean {
  const next = createPaperExperiment({
    experimentId: b.experimentId,
    version: 1,
    capital: b.capital,
    universe: b.universe,
    timeframe: b.timeframe,
  });
  return next.frozenHash !== createPaperExperiment({
    experimentId: a.experimentId,
    version: 1,
    capital: a.capital,
    universe: a.universe,
    timeframe: a.timeframe,
  }).frozenHash;
}
