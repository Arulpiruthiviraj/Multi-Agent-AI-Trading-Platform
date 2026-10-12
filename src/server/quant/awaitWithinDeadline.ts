/**
 * Bounded wait that NEVER cancels or duplicates the underlying work: the caller stops waiting after
 * `ms`, the underlying promise keeps running, and its late settlement (including a late rejection)
 * is absorbed so it cannot become an unhandled rejection. Observability/latency use only.
 */
export type DeadlineOutcome<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

export async function awaitWithinDeadline<T>(work: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
  });
  // Absorb a late rejection after the deadline already released the caller.
  const guarded = work.then((value) => ({ timedOut: false as const, value }));
  guarded.catch(() => undefined);
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
