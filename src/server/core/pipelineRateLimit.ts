/**
 * Sliding-window caps for TRADE_IDEA_GENERATED (post-gate) and AIRouter.routeTask.
 * Reviewed numbers live in config/tradingSafety.json. Fail-closed: drop, do not queue unbounded.
 */
import { tradingSafety } from '../config/tradingSafety';

const WINDOW_MS = 60_000;

const ideaTimes: number[] = [];
const aiTimes: number[] = [];
let ideasDropped = 0;
let aiDropped = 0;

function prune(bucket: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
}

export function allowTradeIdea(now: number = Date.now()): boolean {
  prune(ideaTimes, now);
  if (ideaTimes.length >= tradingSafety.maxTradeIdeasPerMinute) {
    ideasDropped += 1;
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
    aiDropped,
    windowMs: WINDOW_MS,
  };
}

export function resetPipelineRateLimitForTests(): void {
  ideaTimes.length = 0;
  aiTimes.length = 0;
  ideasDropped = 0;
  aiDropped = 0;
}
