/**
 * ==========================================================
 * Module:
 * JevClassificationTask.ts
 *
 * Purpose:
 * Phase 3 extension contract for future Jev classification tasks beyond news
 * triage. Defines the shape any new task must implement to reuse the proven
 * pattern: complete-validated-or-skip state → single batched evaluate() → validated mapping.
 *
 * No task is registered here. Adding a task means implementing this interface
 * in a new module, feature-flagging it default-off, and wiring it through the
 * same shadow-first discipline (Phase 1: log agreement, never influence
 * decisions). Classification only — never reasoning, never recommendations,
 * never votes, never trading signals.
 * ==========================================================
 */

import { JevProvider, JevQuestion } from '../ai/providers/JevProvider';

/**
 * A classification task Jev can serve. Implementations must:
 * - buildState() fails closed (return null on any imperfect input — no request),
 * - batch ALL questions for one decision into a single questions map,
 * - mapAnswer() validates Jev's raw answers into the task's own typed result,
 *   throwing (never inventing) on any malformed answer.
 */
export interface JevClassificationTask<TState, TResult> {
  /** Stable task id for logging/ledgering, e.g. 'news-triage'. */
  readonly taskId: string;
  /** Build the complete, validated state, or null when the input is imperfect. */
  buildState(input: unknown): TState | null;
  /** All questions for one decision — answered in a single evaluate() call. */
  buildQuestions(state: TState): Record<string, JevQuestion>;
  /** Validate Jev's raw answers into the task's typed result. Throws on malformed. */
  mapAnswer(answers: Record<string, unknown>, state: TState): TResult;
  /** Feature-flag env var name, e.g. 'ARGUS_JEV_SHADOW_SCORING_ENABLED'. */
  readonly flagEnvVar: string;
}

export function isTaskEnabled(task: JevClassificationTask<unknown, unknown>): boolean {
  return process.env[task.flagEnvVar] === 'true';
}

/**
 * Run one task end-to-end: state → single batched evaluate() → mapped result.
 * Returns null when the state is imperfect or Jev fails — the caller falls back
 * to its existing path, exactly as if the task never existed.
 */
export async function runClassificationTask<TState, TResult>(
  task: JevClassificationTask<TState, TResult>,
  provider: JevProvider,
  input: unknown,
  options?: { timeoutMs?: number },
): Promise<{ result: TResult; model: string; inputTokens: number; latencyMs: number } | null> {
  if (!isTaskEnabled(task)) return null;
  const state = task.buildState(input);
  if (state === null) return null;
  const started = Date.now();
  try {
    const evaluation = await provider.evaluate(
      state as unknown as Record<string, unknown>,
      task.buildQuestions(state),
      { timeoutMs: options?.timeoutMs ?? 15000 },
    );
    const result = task.mapAnswer(
      evaluation.answers as unknown as Record<string, unknown>,
      state,
    );
    return {
      result,
      model: evaluation.model,
      inputTokens: evaluation.inputTokens,
      latencyMs: Date.now() - started,
    };
  } catch {
    return null;
  }
}
