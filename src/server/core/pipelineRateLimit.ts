/**
 * Sliding-window caps for TRADE_IDEA_GENERATED (post-gate) and AIRouter.routeTask.
 * Reviewed numbers live in config/tradingSafety.json. Fail-closed: drop, do not queue unbounded.
 */
import { tradingSafety } from '../config/tradingSafety';

const WINDOW_MS = 60_000;

const ideaTimes: number[] = [];
const aiTimes: number[] = [];
let ideasDropped = 0;
let protectiveExitsExempted = 0;
/** Per-agent drop counts (bounded keys) so saturation is attributable, not just a global counter (2026-10-15). */
const ideasDroppedByAgent = new Map<string, number>();
const MAX_TRACKED_AGENTS = 64;
let aiDropped = 0;

function prune(bucket: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
}

export interface TradeIdeaRateContext {
  /** Emitting agent, for attribution of drops only. */
  agent?: string;
  /**
   * A genuine protective exit (risk-exit agent SELL with origin PORTFOLIO_EXIT - the same dual-key predicate ChiefTrader uses, never an agent name alone).
   * 2026-10-15: these were subject to the same first-come window as 120 ideas/min of research votes and, when the window saturated (it did, 28-33% drop rate
   * across agents), a stop/target exit could be dropped and only re-emitted one monitor cycle (~60 s) later. A protective exit is not a research vote:
   * it is bounded by open positions and the per-symbol exit cooldown, and still must clear RiskEngine and OMS. It neither consumes nor is denied by the window.
   */
  protectiveExit?: boolean;
}

export function allowTradeIdea(now: number = Date.now(), ctx: TradeIdeaRateContext = {}): boolean {
  if (ctx.protectiveExit === true) {
    protectiveExitsExempted += 1;
    return true;
  }
  prune(ideaTimes, now);
  if (ideaTimes.length >= tradingSafety.maxTradeIdeasPerMinute) {
    ideasDropped += 1;
    const key = ctx.agent && ctx.agent.length > 0 ? ctx.agent : 'UNKNOWN';
    if (ideasDroppedByAgent.has(key) || ideasDroppedByAgent.size < MAX_TRACKED_AGENTS) ideasDroppedByAgent.set(key, (ideasDroppedByAgent.get(key) ?? 0) + 1);
    return false;
  }
  ideaTimes.push(now);
  return true;
}

export function allowAiCall(now: number = Date.now()): boolean {
  prune(aiTimes, now);
  if (aiTimes.length >= tradingSafety.maxAiCallsPerMinute) {
    aiDropped += 1;
    return false;
  }
  aiTimes.push(now);
  return true;
}

export function getPipelineRateSnapshot(now: number = Date.now()): {
  ideasInWindow: number;
  aiCallsInWindow: number;
  maxTradeIdeasPerMinute: number;
  maxAiCallsPerMinute: number;
  ideasDropped: number;
  ideasDroppedByAgent: Record<string, number>;
  protectiveExitsExempted: number;
  aiDropped: number;
  windowMs: number;
} {
  prune(ideaTimes, now);
  prune(aiTimes, now);
  return {
    ideasInWindow: ideaTimes.length,
    aiCallsInWindow: aiTimes.length,
    maxTradeIdeasPerMinute: tradingSafety.maxTradeIdeasPerMinute,
    maxAiCallsPerMinute: tradingSafety.maxAiCallsPerMinute,
    ideasDropped,
    ideasDroppedByAgent: Object.fromEntries(ideasDroppedByAgent),
    protectiveExitsExempted,
    aiDropped,
    windowMs: WINDOW_MS,
  };
}

export function resetPipelineRateLimitForTests(): void {
  ideaTimes.length = 0;
  aiTimes.length = 0;
  ideasDropped = 0;
  protectiveExitsExempted = 0;
  ideasDroppedByAgent.clear();
  aiDropped = 0;
}
