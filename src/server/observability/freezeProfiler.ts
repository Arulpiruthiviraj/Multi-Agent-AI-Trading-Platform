/**
 * freezeProfiler.ts - opt-in diagnostic (ARGUS_FREEZE_PROFILER=true; off by default).
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
const session = new inspector.Session();
session.connectToMainThread();
const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
let profiling = false;
let startedAt = 0;
async function stopAndWrite(reason) {
  try {
    const { profile } = await post('Profiler.stop');
    profiling = false;
    fs.mkdirSync(workerData.dir, { recursive: true });
    const file = path.join(workerData.dir, 'freeze-' + new Date(startedAt).toISOString().replace(/[:.]/g, '-') + '.cpuprofile');
    fs.writeFileSync(file, JSON.stringify(profile));
    parentPort.postMessage({ wrote: file, reason });
  } catch (e) { profiling = false; parentPort.postMessage({ error: String(e) }); }
}
(async () => {
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 10000 });
  setInterval(async () => {
    const silent = Date.now() - beat[0];
    if (!profiling && silent > workerData.thresholdMs) {
      profiling = true; startedAt = Date.now();
      try { await post('Profiler.start'); } catch (e) { profiling = false; }
    } else if (profiling && (silent < workerData.thresholdMs / 2 || Date.now() - startedAt > workerData.maxMs)) {
      await stopAndWrite(silent < workerData.thresholdMs / 2 ? 'resumed' : 'cap');
    }
  }, 1000);
})();
`;

export function startFreezeProfiler(): void {
  if (process.env.ARGUS_FREEZE_PROFILER !== 'true' || worker) return;
  const dir = process.env.ARGUS_FREEZE_PROFILER_DIR || path.join(process.cwd(), 'data', 'freeze-profiles');
  const thresholdMs = Number(process.env.ARGUS_FREEZE_PROFILER_THRESHOLD_MS) || 15000;
  const maxMs = Number(process.env.ARGUS_FREEZE_PROFILER_MAX_MS) || 300000;
  const shared = new SharedArrayBuffer(8);
  const beat = new Float64Array(shared);
  beat[0] = Date.now();
  beatTimer = setInterval(() => { beat[0] = Date.now(); }, 1000);
  beatTimer.unref();
  worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { shared, dir, thresholdMs, maxMs } });
  worker.unref();
  worker.on('message', (m) => console.warn('[FreezeProfiler]', JSON.stringify(m)));
  worker.on('error', (e) => console.warn('[FreezeProfiler] worker error', e));
}

export function stopFreezeProfiler(): void {
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;
  void worker?.terminate();
  worker = null;
}
