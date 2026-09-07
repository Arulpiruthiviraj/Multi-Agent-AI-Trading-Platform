/**
 * heartbeatWatchdog.ts
 *
 * R2 (2026-09-06 post-audit remediation, ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md §30 P1
 * finding #2 / ARGUS_POST_AUDIT_REMEDIATION_PLAN.md): "No active process supervisor - a crash
 * requires manual operator restart." A crash that kills the whole Node process cannot be
 * self-detected from inside that same (now-dead) process - that half of the gap is an operator/ops
 * concern (a real OS-level supervisor - e.g. a Windows service wrapper or scheduled-task restart
 * policy, pm2, systemd - is the correct fix and is outside what this module can or should do).
 *
 * What CAN be detected in-process is the other, complementary failure mode: the process stays
 * alive (HTTP/WS keep answering) while some critical internal worker has gone silently, invisibly
 * dead (an interval whose callback started swallowing every tick without ever recovering). Nothing
 * previously watched for that and reacted - pipelineAgentHealth.ts's heartbeats were a purely
 * passive metric an operator had to think to poll (via getPipelineAgentSnapshot()).
 *
 * Signal chosen deliberately, after ruling out the alternatives:
 * - FundamentalAgent/MacroAgent/TechnicalAgent/QuantEngine/KronosEngine heartbeats are NOT reliable
 *   always-on signals: their timers are started/stopped with Autobot (pipelineAgentRuntime.ts's
 *   startEnabledIdeaAgents()/stopAllIdeaAgents()), or (TechnicalAgent) driven only by real market
 *   ticks - both go legitimately silent for long, normal stretches (Autobot off, market closed)
 *   that must never be confused with a dead process.
 * - NewsAgent is the one agent whose heartbeat ticks unconditionally on its own timer regardless of
 *   Autobot/session state (pipelineAgentRuntime.ts's own header: "NewsAgent keeps NewsEngine
 *   clustering running from process boot... only TRADE_IDEA_GENERATED is gated" - its start/stop
 *   runtime entries are literal no-ops). A prolonged gap in that one heartbeat, corroborated by
 *   MarketDataWorker also reporting disconnected (so a NewsEngine-only glitch alone cannot trip
 *   this), is a genuine silent-death signature.
 *
 * Reuses the exact same reviewed escalation TradingEngine already exposes for reconciliation
 * mismatches - never a new/second kill switch (CLAUDE.md hard rule): setTradingState('TRADING_PAUSED',
 * ...). Never auto-resumes; an operator must investigate and manually re-enable, same as every
 * other pause path in this codebase.
 *
 * No separate boot-warmup window (unlike reconciliation's own 30s one): the only way `suspected`
 * can become true requires NewsAgent's silence to exceed heartbeatWatchdogSilenceThresholdMs
 * (900000ms) - and NewsEngine's own start() fires its first tick immediately, synchronously, at
 * process boot (see NewsEngine.ts's start()), so a "no tick yet" false trigger is already
 * impossible via the plain `newsAgentLastTickAt !== null` check below, with no extra time-based
 * magic number needed on top of it.
 */
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { getPipelineAgentHeartbeat } from './pipelineAgentHealth';

let intervalId: ReturnType<typeof setInterval> | null = null;
let triggeredThisProcess = false;

export interface HeartbeatWatchdogCheckResult {
  suspected: boolean;
  newsAgentLastTickAt: number | null;
  newsAgentSilenceMs: number | null;
  marketDataConnected: boolean;
}

/** Pure check - does not itself pause trading. Exported so tests (and an on-demand diagnostic
 *  route, if ever added) can inspect the current verdict without waiting for the real interval. */
export async function evaluateHeartbeatWatchdog(nowMs: number = Date.now()): Promise<HeartbeatWatchdogCheckResult> {
  const newsHeartbeat = getPipelineAgentHeartbeat('NewsAgent');
  const newsAgentLastTickAt = newsHeartbeat.lastTickAt;
  const newsAgentSilenceMs = newsAgentLastTickAt !== null ? nowMs - newsAgentLastTickAt : null;

  let marketDataConnected = true;
  try {
    // Dynamic import (not a static import) so this module - loaded very early in the boot sequence,
    // see ArgusCoreBoot.ts - never imposes a hard load-order dependency on MarketDataWorker.
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataConnected = marketDataWorker.isConnected();
  } catch {
    // If the check itself throws, fail closed on the side of NOT declaring silent death from a
    // broken diagnostic - a broken diagnostic is a separate bug, not proof of a dead process.
    marketDataConnected = true;
  }

  const newsAgentSilent = newsAgentLastTickAt !== null
    && newsAgentSilenceMs !== null
    && newsAgentSilenceMs > tradingSafety.heartbeatWatchdogSilenceThresholdMs;

  const suspected = newsAgentSilent && !marketDataConnected;

  return { suspected, newsAgentLastTickAt, newsAgentSilenceMs, marketDataConnected };
}

async function tick(): Promise<void> {
  const result = await evaluateHeartbeatWatchdog();
  if (!result.suspected) return;
  if (triggeredThisProcess) return; // one alert/pause per process lifetime - never spam-retrigger

  const { tradingEngine } = await import('../engines/TradingEngine');
  if (tradingEngine.state.tradingState !== 'TRADING_ENABLED') return; // nothing new to pause

  triggeredThisProcess = true;
  const reason = `HeartbeatWatchdog: NewsAgent silent for ${result.newsAgentSilenceMs}ms `
    + `(threshold ${tradingSafety.heartbeatWatchdogSilenceThresholdMs}ms) and MarketDataWorker `
    + `reports disconnected - suspected silent internal failure. Trading paused pending manual review.`;
  console.error(`[HeartbeatWatchdog] ${reason}`);
  eventBus.publish(EVENTS.HEARTBEAT_WATCHDOG_TRIGGERED, {
    timestamp: new Date().toISOString(),
    newsAgentLastTickAt: result.newsAgentLastTickAt,
    newsAgentSilenceMs: result.newsAgentSilenceMs,
    silenceThresholdMs: tradingSafety.heartbeatWatchdogSilenceThresholdMs,
    marketDataConnected: result.marketDataConnected,
  });
  await tradingEngine.setTradingState('TRADING_PAUSED', {
    reason,
    actor: 'system:HeartbeatWatchdog',
  });
}

/** Safe to call multiple times (idempotent no-op if already running). */
export function startHeartbeatWatchdog(): void {
  if (intervalId) return;
  intervalId = setInterval(() => { void tick(); }, runtimeIntervals.heartbeatWatchdogCheckMs);
}

export function stopHeartbeatWatchdog(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/** Test-only. */
export function resetHeartbeatWatchdogForTests(): void {
  stopHeartbeatWatchdog();
  triggeredThisProcess = false;
}
