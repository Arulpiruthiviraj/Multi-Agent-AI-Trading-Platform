/**
 * WallClockAudit - certification instrument that answers: "which production decision code read the REAL wall clock while a
 * synthetic session was running?".
 *
 * Why: the MarketDataWorker simulation-clock seam (2026-10-13) fixed one component that compared simulated quote timestamps with real
 * `Date.now()` and therefore saw every position's price as weeks old. The same class of defect can hide in any other module. Latency
 * measurements, ids and log timestamps legitimately use the real clock; MARKET-TIME decisions (freshness, session, cooldown, expiry)
 * must use the simulation clock.
 *
 * Mechanism: wraps `Date.now` (only inside an isolated SYNTHETIC_SIMULATION process) and attributes each call to its immediate
 * caller (file:function) from a bounded stack capture. The result is a per-caller call count that a reviewed classification file
 * (config/syntheticWallClockAudit.json) must fully explain: an UNCLASSIFIED decision-module caller fails certification, so a new
 * wall-clock read in trading code cannot slip in unnoticed. This is a ratchet plus review, not a proof of absence: a read that is
 * classified SIM_SEAMED/LATENCY_ONLY is trusted to be what the reviewer said.
 * Known limit: only `Date.now()` is observed. The zero-argument `new Date()` constructor does not call `Date.now`, so it is covered by
 * the separate static scan in WallClockAudit.test.ts, not by this runtime recorder.
 */
export interface WallClockCaller { file: string; fn: string; calls: number }

export interface WallClockAuditHandle {
  stop(): WallClockCaller[];
}

const NativeNow = Date.now.bind(Date);

export function startWallClockAudit(): WallClockAuditHandle {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error('WallClockAudit refused: only an isolated SYNTHETIC_SIMULATION process may wrap Date.now.');
  }
  const counts = new Map<string, WallClockCaller>();
  const original = Date.now;
  const holder: { limit: number } = { limit: 0 };
  const wrapped = function auditedNow(): number {
    const prev = Error.stackTraceLimit;
    Error.stackTraceLimit = 3;
    const e: { stack?: string } = {};
    Error.captureStackTrace(e, wrapped);
    Error.stackTraceLimit = prev;
    const line = (e.stack ?? '').split('\n')[1] ?? '';
    // "    at fnName (C:\path\file.ts:12:3)" or "    at C:\path\file.ts:12:3"
    const m = /at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line.trim());
    const file = m ? m[2].replace(/\\/g, '/').replace(/^.*\/(src|scripts|server\.ts)/, '$1') : 'unknown';
    const fn = m?.[1] ?? '<anonymous>';
    const key = `${file}|${fn}`;
    const c = counts.get(key);
    if (c) c.calls++; else counts.set(key, { file, fn, calls: 1 });
    return NativeNow();
  };
  void holder;
  Date.now = wrapped as DateConstructor['now'];
  return {
    stop(): WallClockCaller[] {
      Date.now = original;
      return [...counts.values()].sort((a, b) => b.calls - a.calls);
    },
  };
}

export type WallClockClass = 'SIM_SEAMED' | 'LATENCY_ONLY' | 'ID_OR_LOG_ONLY' | 'REAL_TIME_BY_DESIGN';
export interface WallClockClassification { filePattern: string; classification: WallClockClass; reason: string }

/**
 * Splits observed callers into explained / unexplained. `decisionFilePattern` selects the modules whose clock reads matter
 * (trading-decision code); a caller outside that set is not asserted on. An unexplained decision-module caller is a certification
 * failure. Pure; the classification list comes from reviewed config.
 */
export function evaluateWallClockAudit(
  callers: WallClockCaller[],
  decisionFilePattern: RegExp,
  classifications: WallClockClassification[],
): { explained: Array<WallClockCaller & { classification: WallClockClass; reason: string }>; unexplained: WallClockCaller[]; ignored: number } {
  const explained: Array<WallClockCaller & { classification: WallClockClass; reason: string }> = [];
  const unexplained: WallClockCaller[] = [];
  let ignored = 0;
  for (const c of callers) {
    if (!decisionFilePattern.test(c.file)) { ignored += c.calls; continue; }
    const hit = classifications.find((k) => new RegExp(k.filePattern).test(`${c.file}|${c.fn}`));
    if (hit) explained.push({ ...c, classification: hit.classification, reason: hit.reason });
    else unexplained.push(c);
  }
  return { explained, unexplained, ignored };
}
