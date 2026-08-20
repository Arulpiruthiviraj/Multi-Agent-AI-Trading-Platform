import { replayArgusStrategy } from './src/server/research/argusStrategyReplay';
import type { ResearchBar } from './src/server/research/ohlcvTypes';

function synthBars(n: number): ResearchBar[] {
  const bars: ResearchBar[] = [];
  let t = Date.UTC(2020, 0, 1, 14, 30, 0);
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i / 7) * 0.8 + (Math.random() - 0.5) * 0.3;
    const open = price - 0.1;
    const close = price;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    bars.push({ timestamp: t, open, high, low, close, volume: 1_000_000 + i * 500 });
    t += 86_400_000;
  }
  return bars;
}

const N = 1000;
const allBars = synthBars(N);
const strategyId = 'MOMENTUM_BREAKOUT';

// Simulates FullArgusReplayEngine.ts's tick loop: call replayArgusStrategy fresh at every tick
// with that tick's entire accumulated visible-bar history (bars 0..i), exactly like the real
// replay loop does. MIN_BARS-ish floor to skip the earliest handful of trivially-fast calls.
function timeTickLoop(onlyLatestBar: boolean, ticks: number): number {
  const start = performance.now();
  for (let i = 30; i < ticks; i++) {
    const visible = allBars.slice(0, i + 1);
    replayArgusStrategy({ strategyId, bars: visible, provenance: 'UNIT_FIXTURE', onlyLatestBar });
  }
  return performance.now() - start;
}

// Smaller N for the OLD (onlyLatestBar:false) path since it's genuinely O(ticks^3) and 1000 ticks
// would take an impractically long time to actually finish for this benchmark.
const OLD_N = 300;
console.log(`Benchmarking replayArgusStrategy tick-loop cost (synthetic data, no network, no DB)...`);
const oldMs = timeTickLoop(false, OLD_N);
console.log(`OLD behavior (onlyLatestBar:false) over ${OLD_N} ticks: ${oldMs.toFixed(0)}ms  (~${(oldMs / OLD_N).toFixed(2)}ms/tick avg)`);

const newMs1000 = timeTickLoop(true, N);
console.log(`NEW behavior (onlyLatestBar:true)  over ${N} ticks: ${newMs1000.toFixed(0)}ms  (~${(newMs1000 / N).toFixed(2)}ms/tick avg)`);

const newMsSameN = timeTickLoop(true, OLD_N);
console.log(`NEW behavior (onlyLatestBar:true)  over ${OLD_N} ticks (same N as OLD run above): ${newMsSameN.toFixed(0)}ms`);
console.log(`Speedup at N=${OLD_N}: ${(oldMs / newMsSameN).toFixed(1)}x`);
