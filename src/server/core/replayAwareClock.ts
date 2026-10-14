/**
 * replayAwareClock - "now" for decisions that compare against ORDER / FILL timestamps (2026-10-13).
 *
 * Inside a replay / synthetic session the OMS stamps order and fill times with the simulated clock (so cooldown and daily-limit gates, which
 * read the replay clock, see consistent ages). Any other check that computes an AGE from those stamps (follow-up age, crash-recovery lookback,
 * unresolved-order reservation) must read the same clock, or a fresh simulated order looks weeks old. Outside a replay session this is exactly
 * `Date.now()` - no live behaviour change. Real-time deadlines (poll timeouts, rate limits) keep using the wall clock.
 */
import { getActiveReplaySession } from '../replay/ReplayContext';

export function replayAwareNowMs(): number {
  try {
    const session = getActiveReplaySession() as { clock?: { now(): number } } | null;
    if (session?.clock && typeof session.clock.now === 'function') {
      const t = session.clock.now();
      if (Number.isFinite(t)) return t;
    }
  } catch { /* no active replay session */ }
  return Date.now();
}
