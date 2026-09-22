/**
 * ARGUS Crypto V2 - synthetic population simulator CLI (2026-09-21). Standalone script, run via
 * `npx tsx scripts/crypto_sim_cli.ts <command> [--flags]`. Imports only from
 * src/server/crypto/synthetic/ - pure, isolated, in-process computation. Never imports
 * BrokerManager/RiskEngine/OMS/the production db module, never touches the running Argus engine
 * or data/argus.db (matches every other read-only utility script in this directory, e.g.
 * compute_pbo.ts). Every command here is safe to run alongside a live Argus instance.
 */
import {
  generateSyntheticCryptoPopulation,
} from '../src/server/crypto/synthetic/SyntheticCryptoPopulationGenerator';
import { generateRegimePath } from '../src/server/crypto/synthetic/SyntheticCryptoRegimeStateMachine';
import {
  generateBtcFactorReturns,
  generateSyntheticCryptoPricePath,
} from '../src/server/crypto/synthetic/SyntheticCryptoPriceProcess';
import { runMonteCarlo } from '../src/server/crypto/synthetic/SyntheticMonteCarloRunner';
import { recordExperiment, readAllExperiments } from '../src/server/crypto/synthetic/SyntheticExperimentRegistry';
import { SyntheticRandom } from '../src/server/replay/synthetic/SyntheticRandom';

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z0-9]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
}

function cmdPopulation(flags: Record<string, string>): void {
  const seed = Number(flags.seed ?? 1);
  const size = Number(flags.size ?? 100);
  const bars = Number(flags.bars ?? 1000);
  const t0 = process.hrtime.bigint();
  const memBefore = process.memoryUsage().heapUsed;
  const population = generateSyntheticCryptoPopulation({ populationSeed: seed, populationSize: size }, bars);
  const t1 = process.hrtime.bigint();
  const memAfter = process.memoryUsage().heapUsed;

  const liquidityCounts: Record<string, number> = {};
  const clusterCounts: Record<string, number> = {};
  const archetypeCounts: Record<string, number> = {};
  for (const asset of population) {
    liquidityCounts[asset.liquidityBucket] = (liquidityCounts[asset.liquidityBucket] ?? 0) + 1;
    clusterCounts[asset.correlationCluster] = (clusterCounts[asset.correlationCluster] ?? 0) + 1;
    archetypeCounts[asset.behavioralArchetype] = (archetypeCounts[asset.behavioralArchetype] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    command: 'population',
    seed, size, bars,
    wallClockMs: Number(t1 - t0) / 1e6,
    heapDeltaBytes: memAfter - memBefore,
    btcAnchor: population[0].syntheticSymbol,
    ethAnchor: population[1].syntheticSymbol,
    liquidityCounts, clusterCounts, archetypeCounts,
  }, null, 2));
}

function cmdPricepath(flags: Record<string, string>): void {
  const seed = Number(flags.seed ?? 1);
  const bars = Number(flags.bars ?? 1000);
  const population = generateSyntheticCryptoPopulation({ populationSeed: seed, populationSize: 2 }, bars);
  const btcAsset = population[0];
  const regimePath = generateRegimePath(new SyntheticRandom(seed * 2), bars, 'RANGE');
  const btcReturns = generateBtcFactorReturns(new SyntheticRandom(seed * 2 + 1), regimePath, btcAsset.baseVolatilityPerBar);
  const btcBars = generateSyntheticCryptoPricePath(btcAsset, regimePath, btcReturns, new SyntheticRandom(seed * 2 + 2), 0, 60_000);

  console.log(JSON.stringify({
    command: 'pricepath',
    symbol: btcAsset.syntheticSymbol,
    bars: btcBars.length,
    firstClose: btcBars[0]?.close,
    lastClose: btcBars[btcBars.length - 1]?.close,
    totalReturn: btcBars.length > 1 ? (btcBars[btcBars.length - 1].close - btcBars[0].open) / btcBars[0].open : null,
  }, null, 2));
}

/** Generates the full price path (not just the population metadata) for every asset - the
 *  realistic end-to-end throughput measure (mandate section 33's benchmark matrix), since
 *  population generation alone is far cheaper than actually simulating every asset's bars. */
function cmdFullSim(flags: Record<string, string>): void {
  const seed = Number(flags.seed ?? 1);
  const size = Number(flags.size ?? 100);
  const bars = Number(flags.bars ?? 1000);

  const t0 = process.hrtime.bigint();
  const memBefore = process.memoryUsage().heapUsed;

  const population = generateSyntheticCryptoPopulation({ populationSeed: seed, populationSize: size }, bars);
  const regimePath = generateRegimePath(new SyntheticRandom(seed * 2), bars, 'RANGE');
  const btcAsset = population[0];
  const btcReturns = generateBtcFactorReturns(new SyntheticRandom(seed * 2 + 1), regimePath, btcAsset.baseVolatilityPerBar);

  let totalBarsGenerated = 0;
  for (let i = 0; i < population.length; i++) {
    const asset = population[i];
    const assetBars = generateSyntheticCryptoPricePath(asset, regimePath, btcReturns, new SyntheticRandom(seed * 1000 + i), 0, 60_000);
    totalBarsGenerated += assetBars.length;
  }

  const t1 = process.hrtime.bigint();
  const memAfter = process.memoryUsage().heapUsed;
  const wallClockMs = Number(t1 - t0) / 1e6;

  console.log(JSON.stringify({
    command: 'fullsim',
    seed, assetCount: size, barsPerAsset: bars,
    totalBarsGenerated,
    wallClockMs,
    barsPerSecond: Math.round(totalBarsGenerated / (wallClockMs / 1000)),
    heapDeltaMB: (memAfter - memBefore) / (1024 * 1024),
  }, null, 2));
}

function cmdMonteCarlo(flags: Record<string, string>): void {
  const seedCount = Number(flags.seeds ?? 20);
  const size = Number(flags.size ?? 100);
  const bars = Number(flags.bars ?? 500);
  const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);
  const t0 = process.hrtime.bigint();
  const summary = runMonteCarlo(seeds, size, bars);
  const t1 = process.hrtime.bigint();

  console.log(JSON.stringify({
    command: 'montecarlo',
    seedCount, size, bars,
    wallClockMs: Number(t1 - t0) / 1e6,
    btcTotalReturn: summary.btcTotalReturn,
  }, null, 2));

  if (flags.record === 'true') {
    recordExperiment({
      experimentId: `mc-${Date.now()}`,
      populationSeed: seeds[0],
      scenarioSeed: null,
      assetCount: size,
      totalBars: bars,
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      resultSummary: {
        seedCount,
        medianBtcReturn: summary.btcTotalReturn.median,
        wallClockMs: Number(t1 - t0) / 1e6,
      },
      status: 'MONTE_CARLO',
    });
    console.log('Recorded to data/argus-synthetic/experiments/registry.jsonl');
  }
}

function cmdReport(): void {
  const all = readAllExperiments();
  console.log(JSON.stringify({ command: 'report', experimentCount: all.length, experiments: all }, null, 2));
}

function main(): void {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'population':
      cmdPopulation(flags);
      break;
    case 'pricepath':
      cmdPricepath(flags);
      break;
    case 'fullsim':
      cmdFullSim(flags);
      break;
    case 'montecarlo':
      cmdMonteCarlo(flags);
      break;
    case 'report':
      cmdReport();
      break;
    default:
      console.log('Usage: npx tsx scripts/crypto_sim_cli.ts <population|pricepath|fullsim|montecarlo|report> [--flag=value]');
      process.exit(command ? 1 : 0);
  }
}

main();
