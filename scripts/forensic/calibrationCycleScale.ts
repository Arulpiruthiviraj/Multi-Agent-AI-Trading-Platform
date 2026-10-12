// Forensic diagnostic (isolated temp DB only; never touches data/argus.db). Seeds a production-SHAPED history
// (Oct-12: 523k predictions, 229k kronos rows with 8k outcomes, 73k agent outcomes, 38 calibration rows) and times
// buildCalibrationCandidates(), reporting the longest event-loop gap. Run: npx tsx scripts/forensic/calibrationCycleScale.ts
// Measured 2026-10-12: old code = one 11.6 s uninterrupted block; fixed code = 1.9 s total, max gap 177 ms.
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.tmpdir(), `argus_calib_scale_${Date.now()}.db`);
process.env.ARGUS_DB_PATH = dbPath;
const { sqliteDb } = await import('../../src/server/db');
const mod = await import('../../src/server/continuous/CalibrationCandidateBuilder');

const now = new Date().toISOString();
const base = Date.parse('2026-09-01T14:00:00Z');
const symbols = Array.from({ length: 300 }, (_, i) => `S${i}`);
// production shape: 523k predictions (Kronos 229k, DiscoveryOutcomeTracker 114k, Macro 96k, Technical 58k, Quant 17k, ...), 73k agent outcomes
const agents: Array<[string, number, number]> = [
  ['KronosEngine', 229200, 8000], ['DiscoveryOutcomeTracker', 114389, 30000], ['MacroAgent', 96435, 6000],
  ['TechnicalAgent', 58244, 20000], ['QuantEngine', 16771, 6000], ['JavaFactorComposite', 7547, 3000], ['NewsAgent', 3000, 1500],
];
const insCal = sqliteDb.prepare('INSERT INTO agent_confidence_calibration (agent_name, bucket_low, bucket_high, wins, losses, calibrated_confidence, last_evaluated, provider) VALUES (?,?,?,?,?,?,?,?)');
const calAgents: Array<[string, number]> = [['KronosEngine', 4], ['QuantEngine', 4], ['TechnicalAgent', 4], ['NewsAgent', 17], ['DiscoveryOutcomeTracker', 1], ['MacroAgent', 1], ['JavaFactorComposite', 1]];
const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
for (const [a, n] of calAgents) for (let i = 0; i < n; i++) { const lo = edges[i % 5]; insCal.run(a, lo, edges[(i % 5) + 1], 1, 1, 0.5, now, i < 5 ? 'ALL' : 'prov' + Math.floor(i / 5)); }

const insPred = sqliteDb.prepare('INSERT INTO agent_predictions (id, agent_name, symbol, prediction, confidence, reasoning, timestamp) VALUES (?,?,?,?,?,?,?)');
const insKron = sqliteDb.prepare('INSERT INTO kronos_predictions (symbol, prediction, confidence, forecast_horizon, expected_move, volatility, support, resistance, model, predicted_ohlc, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insOut = sqliteDb.prepare('INSERT INTO prediction_outcomes (prediction_id, source_table, symbol, outcome, evaluated_at) VALUES (?,?,?,?,?)');
const filler = 'reasoning text for a deterministic prediction '.repeat(6);
const ohlc = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }))).repeat(2);
let t = Date.now();
sqliteDb.transaction(() => {
  for (const [agent, rows, outcomes] of agents) {
    for (let i = 0; i < rows; i++) {
      const sym = symbols[i % symbols.length];
      const conf = agent === 'KronosEngine' ? 50 + (i % 50) : 0.5 + ((i * 7919) % 500) / 1000;
      const ts = new Date(base + i * 30_000).toISOString();
      if (agent === 'KronosEngine') {
        const info = insKron.run(sym, i % 2 ? 'BUY' : 'SELL', conf, 5, '1%', 'LOW', 1, 2, 'm', ohlc, ts);
        if (i < outcomes) insOut.run(String(info.lastInsertRowid), 'kronos_predictions', sym, i % 3 ? 'WIN' : 'LOSS', now);
        // also mirror into agent_predictions as production does (KronosEngine appears there too)
      } else {
        const id = `${agent}-${i}`;
        insPred.run(id, agent, sym, i % 3 === 0 ? 'SELL' : 'BUY', conf, filler + i, ts);
        if (i < outcomes) insOut.run(id, 'agent_predictions', sym, i % 4 === 0 ? 'N_A' : i % 2 ? 'WIN' : 'LOSS', now);
      }
    }
  }
})();
console.log('seeded in', Date.now() - t, 'ms');

let last = performance.now();
let maxGap = 0;
let blocks = 0;
const timer = setInterval(() => { const n = performance.now(); const g = n - last; if (g > 1000) blocks++; maxGap = Math.max(maxGap, g); last = n; }, 5);
const cpu0 = process.cpuUsage();
t = Date.now();
const out = await mod.buildCalibrationCandidates();
const wall = Date.now() - t;
clearInterval(timer);
maxGap = Math.max(maxGap, performance.now() - last);
const cpu = process.cpuUsage(cpu0);
console.log(JSON.stringify({ candidates: out.length, wallMs: wall, cpuMs: Math.round((cpu.user + cpu.system) / 1000), maxEventLoopGapMs: Math.round(maxGap), gapsOver1s: blocks }));
try { sqliteDb.close(); } catch { /* */ }
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(dbPath + s); } catch { /* */ } }
process.exit(0);
