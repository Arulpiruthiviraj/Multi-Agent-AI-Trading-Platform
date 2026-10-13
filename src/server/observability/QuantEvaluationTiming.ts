import { performance } from 'node:perf_hooks';

export type QuantEvaluationStage = 'PRIMARY_BARS' | 'INTRADAY_BARS' | 'REGIME'
  | 'MARKET_CONTEXT' | 'FEATURES' | 'STRATEGIES' | 'SELECTION_AND_ECONOMICS'
  | 'AI_REVIEW' | 'IDEA_EMISSION' | 'PERSISTENCE';

/** Per-call, bounded timing data attached to the existing completion event. No new timer,
 * queue, decision policy or durable store. Durations include await time and host stalls;
 * they must never be presented as CPU time or proof of provider execution time.
 */
export class QuantEvaluationTiming {
  private readonly started: number;
  private stageStarted: number;
  private stage: QuantEvaluationStage = 'PRIMARY_BARS';
  private readonly durations: Partial<Record<QuantEvaluationStage, number>> = {};
  /** 2026-10-13 data-age provenance recorded by the evaluation body; null = not measured (never invented). */
  readonly provenance: {
    dailyLastBarMs: number | null; intradayLastBarMs: number | null;
    intradayOutcome: 'INTRADAY_NOT_REQUIRED' | 'AVAILABLE' | 'EMPTY' | 'DEADLINE' | 'FETCH_ERROR' | 'WINDOW_UNAVAILABLE' | null;
  } = { dailyLastBarMs: null, intradayLastBarMs: null, intradayOutcome: null };
  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = this.stageStarted = now();
  }
  enter(stage: QuantEvaluationStage): void {
    const at = this.now();
    this.durations[this.stage] = (this.durations[this.stage] ?? 0) + Math.max(0, at - this.stageStarted);
    this.stage = stage;
    this.stageStarted = at;
  }
  snapshot() {
    const at = this.now();
    return { durationMs: Math.max(0, at - this.started), lastStage: this.stage,
      stageDurationsMs: { ...this.durations, [this.stage]: (this.durations[this.stage] ?? 0) + Math.max(0, at - this.stageStarted) },
      timingScope: 'ELAPSED_INCLUDING_AWAIT_AND_HOST_STALLS' as const };
  }
}

/** Persist a bounded diagnosis, never provider response text, URLs or credentials.
 * Pattern matches classify observed errors; they do not prove which subsystem caused them.
 */
export function quantEvaluationErrorKind(error: unknown): string {
  try {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (/COALESCE_CALLER_TIMEOUT/.test(message)) return 'COALESCE_CALLER_TIMEOUT';
    if (/429|rate-limited|Too Many Requests/i.test(message)) return 'RATE_LIMITED';
    if (/DATA_STALE/.test(message)) return 'DATA_STALE';
    if ((error as { name?: string })?.name === 'AbortError') return 'ABORTED';
    if (/timeout|timed out/i.test(message)) return 'TIMEOUT';
  } catch { /* diagnosis must not replace the original error */ }
  return 'UNCLASSIFIED_ERROR';
}
