/**
 * freezeProfiler.ts - diagnostic (on by default; ARGUS_FREEZE_PROFILER=false disables).
 *
 * Oct-12 2026: the engine froze ~220 s every ~15 min and `--cpu-prof` could not capture it
 * (profiles flush only on graceful exit, and the HTTP drain cannot run during a freeze). A worker
 * thread watches a shared heartbeat the main thread bumps on a timer; when the main thread has been
 * silent longer than the threshold, the worker attaches an inspector session to the main thread
 * (`connectToMainThread`, which works while JS is blocked), samples until the heartbeat resumes (or a
 * cap), and writes a `.cpuprofile` to ARGUS_FREEZE_PROFILER_DIR. Diagnostic only: never touches
 * trading, the DB, or the broker.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';

let worker: Worker | null = null;
let beatTimer: ReturnType<typeof setInterval> | null = null;

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');
const beat = new Float64Array(workerData.shared);
setInterval(() => {}, 60000); // keep the worker alive: pending inspector callbacks alone do not hold its event loop open
const session = new inspector.Session();
session.connectToMainThread();
const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
// Rolling profile: Profiler.start/stop are dispatched ON the main thread, so they cannot be issued while the
// main thread is stuck in a long synchronous (or native) call. Keep a profile running ALWAYS (restarted every
// rollMs while healthy, bounded memory) and, once the main thread resumes after a freeze, stop it: the stopped
// profile then contains the samples (and the JS call stacks) from the whole freeze.
let windowStart = 0, inFreeze = false, freezeStartedAt = 0, busy = false;
async function startWindow() { await post('Profiler.start'); windowStart = Date.now(); }
async function stopWindow() { const { profile } = await post('Profiler.stop'); return profile; }
(async () => {
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: workerData.intervalUs });
    await startWindow();
    parentPort.postMessage({ ready: true });
  } catch (e) { parentPort.postMessage({ error: 'init: ' + String(e) }); return; }
  setInterval(async () => {
    if (busy) return;
    const now = Date.now();
    const silent = now - beat[0];
    try {
      if (!inFreeze && silent > workerData.thresholdMs) { inFreeze = true; freezeStartedAt = now - silent; return; }
      if (inFreeze && silent < workerData.thresholdMs / 2) {
        busy = true;
        const profile = await stopWindow();
        inFreeze = false;
        fs.mkdirSync(workerData.dir, { recursive: true });
        const file = path.join(workerData.dir, 'freeze-' + new Date(freezeStartedAt).toISOString().replace(/[:.]/g, '-') + '.cpuprofile');
        fs.writeFileSync(file, JSON.stringify(profile));
        parentPort.postMessage({ wrote: file, freezeMs: now - freezeStartedAt });
        await startWindow();
        busy = false;
        return;
      }
      if (!inFreeze && now - windowStart > workerData.rollMs) {
        busy = true;
        await stopWindow();
        await startWindow();
        busy = false;
      }
    } catch (e) { busy = false; parentPort.postMessage({ error: String(e) }); }
  }, 1000);
})();
`;

export function startFreezeProfiler(): void {
  // On by default (idle worker + 1 s heartbeat; profiles only during a real freeze); ARGUS_FREEZE_PROFILER=false disables.
  if (process.env.ARGUS_FREEZE_PROFILER === 'false' || process.env.SYNTHETIC_SIMULATION === 'true' || process.env.VITEST || worker) return;
  const dir = process.env.ARGUS_FREEZE_PROFILER_DIR || path.join(process.cwd(), 'data', 'freeze-profiles');
  const thresholdMs = Number(process.env.ARGUS_FREEZE_PROFILER_THRESHOLD_MS) || 6000;
  const shared = new SharedArrayBuffer(8);
  const beat = new Float64Array(shared);
  beat[0] = Date.now();
  beatTimer = setInterval(() => { beat[0] = Date.now(); }, 1000);
  beatTimer.unref();
  worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { shared, dir, thresholdMs, rollMs: 60000, intervalUs: 20000 } });
  worker.unref();
  worker.on('message', (m) => console.warn('[FreezeProfiler]', JSON.stringify(m)));
  worker.on('error', (e) => console.warn('[FreezeProfiler] worker error', e));
  worker.on('exit', (c) => console.warn('[FreezeProfiler] worker exit', c));
}

export function stopFreezeProfiler(): void {
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;
  void worker?.terminate();
  worker = null;
}
