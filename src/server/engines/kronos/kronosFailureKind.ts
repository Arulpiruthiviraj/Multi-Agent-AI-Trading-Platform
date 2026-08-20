/**
 * Classify Chronos forecast failures so a single-symbol CPU timeout cannot
 * latch the entire Kronos path as globally unavailable.
 *
 * Transient: that forecast fails closed; other symbols may still call Chronos.
 * Hard: service looks down — markUnavailable until /health recovers.
 */
export type KronosFailureKind = 'transient' | 'hard';

export function classifyKronosForecastFailure(error: unknown): KronosFailureKind {
  const name = String((error as { name?: string } | null)?.name ?? '');
  const msg = String((error as { message?: string } | null)?.message ?? error ?? '');
  const blob = `${name} ${msg}`.toLowerCase();

  // AbortSignal.timeout / fetch abort — Chronos may still be healthy, just slow (CPU fan-out).
  if (
    blob.includes('timeouterror') ||
    blob.includes('aborterror') ||
    blob.includes('timed out') ||
    blob.includes('timeout') ||
    /\baborted\b/.test(blob)
  ) {
    return 'transient';
  }

  return 'hard';
}
