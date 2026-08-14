/**
 * ==========================================================
 * Module: RateLimiters.ts
 *
 * Purpose:
 * Real, enforced rate limits for the endpoint categories the P0 security pass called out:
 * login/authentication attempts, AI-driven endpoints, trading-mutating endpoints, and backtest
 * runs - plus a hand-rolled limiter for raw WebSocket upgrade requests, which never pass through
 * Express middleware at all (the 'upgrade' HTTP event bypasses the Express request pipeline
 * entirely, so express-rate-limit cannot see it).
 *
 * Each limiter is deliberately narrow (one concern, one config) rather than a single shared
 * "API limiter" - login needs to be strict enough to make brute-forcing impractical without
 * blocking normal use, while AI/backtest calls are naturally slower and rarer and need a looser,
 * cost-shaped limit instead.
 * ==========================================================
 */
import rateLimit from 'express-rate-limit';

const MINUTE = 60 * 1000;

// Login: the actual brute-force surface. 10 attempts / 10 minutes per IP is generous enough for
// a real user who mistypes a password a few times, but makes a password-guessing loop pointless.
export const loginLimiter = rateLimit({
  windowMs: 10 * MINUTE,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

// AI-driven endpoints (LLM consensus calls, prompt evolution, etc.) - these are already
// naturally expensive/slow; the limit exists to stop a scripting mistake or abusive client from
// running up real provider cost, not to throttle normal interactive use.
export const aiLimiter = rateLimit({
  windowMs: 5 * MINUTE,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request rate limit exceeded. Try again shortly.' },
});

// Trading-mutating endpoints (kill switch, autobot toggle, direct trade/verify calls). Loose
// enough for legitimate rapid manual control (e.g. toggling emergency stop then resuming), tight
// enough to stop a runaway client loop from hammering order-adjacent endpoints.
export const tradingLimiter = rateLimit({
  windowMs: MINUTE,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trading endpoint rate limit exceeded. Try again shortly.' },
});

// Backtests are genuinely expensive (real historical data fetch + full walk-forward run) - a
// small, strict limit is appropriate here, unlike the higher-frequency limiters above.
export const backtestLimiter = rateLimit({
  windowMs: 5 * MINUTE,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Backtest rate limit exceeded. Try again in a few minutes.' },
});

/**
 * Hand-rolled sliding-window counter for WebSocket *connection creation*, keyed by remote IP.
 * Not an express-rate-limit instance because the raw `httpServer.on('upgrade', ...)` handler
 * never runs through Express middleware - this has to be checked manually in that handler.
 */
class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly max: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const existing = (this.hits.get(key) || []).filter(t => t > cutoff);
    if (existing.length >= this.max) {
      this.hits.set(key, existing);
      return false;
    }
    existing.push(now);
    this.hits.set(key, existing);
    // Bound memory: forget IPs with no recent activity instead of growing forever.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every(t => t <= cutoff)) this.hits.delete(k);
      }
    }
    return true;
  }
}

// 20 new WebSocket connections per minute per IP is far above any real single-browser-tab usage
// (one connection, reconnecting occasionally on network blips) but stops a connection-flood.
export const wsUpgradeLimiter = new SlidingWindowLimiter(MINUTE, 20);
