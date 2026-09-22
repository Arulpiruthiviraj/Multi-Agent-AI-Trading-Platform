import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { recordExperiment, readAllExperiments, type SyntheticExperimentRecord } from './SyntheticExperimentRegistry';

const TEST_REGISTRY_PATH = path.join('data', 'argus-synthetic', 'experiments', '__test_registry__.jsonl');

function sampleRecord(overrides: Partial<SyntheticExperimentRecord> = {}): SyntheticExperimentRecord {
  return {
    experimentId: 'exp-1',
    populationSeed: 42,
    scenarioSeed: 1,
    assetCount: 100,
    totalBars: 500,
    startedAtMs: 1000,
    finishedAtMs: 2000,
    resultSummary: { wallClockMs: 1000 },
    status: 'RESEARCH_ONLY',
    ...overrides,
  };
}

describe('SyntheticExperimentRegistry', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_REGISTRY_PATH)) fs.rmSync(TEST_REGISTRY_PATH);
  });

  it('refuses to write outside data/argus-synthetic/', () => {
    expect(() => recordExperiment(sampleRecord(), 'data/argus.db')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
  });

  it('refuses to read outside data/argus-synthetic/', () => {
    expect(() => readAllExperiments('data/experiments/registry.jsonl')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
  });

  it('returns an empty array when no registry file exists yet', () => {
    expect(readAllExperiments(TEST_REGISTRY_PATH)).toEqual([]);
  });

  it('records and reads back an experiment exactly', () => {
    const record = sampleRecord();
    recordExperiment(record, TEST_REGISTRY_PATH);
    const all = readAllExperiments(TEST_REGISTRY_PATH);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(record);
  });

  it('appends multiple experiments without overwriting prior entries', () => {
    recordExperiment(sampleRecord({ experimentId: 'exp-1' }), TEST_REGISTRY_PATH);
    recordExperiment(sampleRecord({ experimentId: 'exp-2' }), TEST_REGISTRY_PATH);
    const all = readAllExperiments(TEST_REGISTRY_PATH);
    expect(all.map((r) => r.experimentId)).toEqual(['exp-1', 'exp-2']);
  });
});
