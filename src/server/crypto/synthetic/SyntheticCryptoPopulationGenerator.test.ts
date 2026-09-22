import { describe, it, expect } from 'vitest';
import { generateSyntheticCryptoPopulation } from './SyntheticCryptoPopulationGenerator';
import { SYNTHETIC_BTC_SYMBOL, SYNTHETIC_ETH_SYMBOL } from './SyntheticCryptoAssetTypes';

describe('generateSyntheticCryptoPopulation', () => {
  it('is deterministic: the same seed and size produce byte-identical populations', () => {
    const a = generateSyntheticCryptoPopulation({ populationSeed: 20260914, populationSize: 500 }, 1000);
    const b = generateSyntheticCryptoPopulation({ populationSeed: 20260914, populationSize: 500 }, 1000);
    expect(a).toEqual(b);
  });

  it('a different seed produces a materially different population', () => {
    const a = generateSyntheticCryptoPopulation({ populationSeed: 1, populationSize: 200 }, 1000);
    const b = generateSyntheticCryptoPopulation({ populationSeed: 2, populationSize: 200 }, 1000);
    // Non-anchor assets (index >= 2) should differ in at least symbol assignment for most entries.
    const differing = a.slice(2).filter((asset, i) => asset.syntheticSymbol !== b[i + 2].syntheticSymbol).length;
    expect(differing).toBeGreaterThan(a.length * 0.3);
  });

  it('always places the BTC and ETH anchors first, with correct clusters and full BTC loading', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 42, populationSize: 100 }, 1000);
    expect(population[0].syntheticSymbol).toBe(SYNTHETIC_BTC_SYMBOL);
    expect(population[0].correlationCluster).toBe('BTC_CORE');
    expect(population[0].btcFactorLoading).toBe(1.0);
    expect(population[1].syntheticSymbol).toBe(SYNTHETIC_ETH_SYMBOL);
    expect(population[1].correlationCluster).toBe('ETH_CORE');
  });

  it('produces a heterogeneous population - not every asset has the same bucket/cluster/archetype', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 7, populationSize: 500 }, 1000);
    const liquidityBuckets = new Set(population.map((a) => a.liquidityBucket));
    const volatilityBuckets = new Set(population.map((a) => a.volatilityBucket));
    const clusters = new Set(population.map((a) => a.correlationCluster));
    const archetypes = new Set(population.map((a) => a.behavioralArchetype));

    expect(liquidityBuckets.size).toBeGreaterThan(1);
    expect(volatilityBuckets.size).toBeGreaterThan(1);
    expect(clusters.size).toBeGreaterThan(1);
    expect(archetypes.size).toBeGreaterThan(1);
  });

  it('every synthetic symbol is unique within a population', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 99, populationSize: 800 }, 1000);
    const symbols = new Set(population.map((a) => a.syntheticSymbol));
    expect(symbols.size).toBe(population.length);
  });

  it('every symbol is SYN-prefixed, mechanically distinct from a real listed ticker', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 5, populationSize: 300 }, 1000);
    for (const asset of population) {
      expect(asset.syntheticSymbol.startsWith('SYN')).toBe(true);
    }
  });

  it('produces at least one asset from each of NEWLY_LISTED and DELISTING_CANDIDATE archetypes at moderate population size', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 11, populationSize: 500 }, 1000);
    const archetypes = population.map((a) => a.behavioralArchetype);
    expect(archetypes).toContain('NEWLY_LISTED');
    expect(archetypes).toContain('DELISTING_CANDIDATE');
  });

  it('NEWLY_LISTED assets have a positive listingBarIndex and DELISTING_CANDIDATE assets have a set delistingBarIndex', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 11, populationSize: 500 }, 1000);
    for (const asset of population) {
      if (asset.behavioralArchetype === 'NEWLY_LISTED') {
        expect(asset.listingBarIndex).toBeGreaterThan(0);
      }
      if (asset.behavioralArchetype === 'DELISTING_CANDIDATE') {
        expect(asset.delistingBarIndex).not.toBeNull();
      }
    }
  });

  it('scales to a 1,000-asset population without error and stays deterministic at that size', () => {
    const a = generateSyntheticCryptoPopulation({ populationSeed: 123, populationSize: 1000 }, 2000);
    const b = generateSyntheticCryptoPopulation({ populationSeed: 123, populationSize: 1000 }, 2000);
    expect(a).toHaveLength(1000);
    expect(a).toEqual(b);
  });

  it('stablecoin-cluster assets are forced to LOW volatility and STABLECOIN_LIKE archetype', () => {
    const population = generateSyntheticCryptoPopulation({ populationSeed: 33, populationSize: 500 }, 1000);
    const stablecoins = population.filter((a) => a.correlationCluster === 'STABLECOIN');
    expect(stablecoins.length).toBeGreaterThan(0);
    for (const asset of stablecoins) {
      expect(asset.volatilityBucket).toBe('LOW');
      expect(asset.behavioralArchetype).toBe('STABLECOIN_LIKE');
    }
  });
});
