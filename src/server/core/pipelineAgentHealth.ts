/**
 * Shared heartbeat for pipeline idea agents.
 *
 * Distinguishes "enabled + gated" from "enabled + the timer/listener is dead".
 * lastTickAt is recorded at the top of every scheduled tick, before Autobot/pipeline gates.
 */
import { tradingSafety } from '../config/tradingSafety';

export type PipelineAgentHealthState = 'IDLE' | 'TICKING' | 'SUCCESS' | 'FAILED' | 'GATED';

export interface PipelineAgentHeartbeat {
  lastTickAt: number | null;
  lastSuccessfulTickAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  currentState: PipelineAgentHealthState;
}

function emptyHeartbeat(): PipelineAgentHeartbeat {
  return {
    lastTickAt: null,
    lastSuccessfulTickAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastError: null,
    currentState: 'IDLE',
  };
}

const heartbeats = new Map<string, PipelineAgentHeartbeat>();

function ensure(id: string): PipelineAgentHeartbeat {
  let row = heartbeats.get(id);
  if (!row) {
    row = emptyHeartbeat();
    heartbeats.set(id, row);
  }
  return row;
}

function clipError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown');
  return raw.slice(0, 240);
}

export function notePipelineAgentTick(agentId: string): void {
  const row = ensure(agentId);
  row.lastTickAt = Date.now();
  if (row.currentState !== 'FAILED') row.currentState = 'TICKING';
}

export function notePipelineAgentSuccess(agentId: string): void {
  const row = ensure(agentId);
  row.lastSuccessfulTickAt = Date.now();
  row.consecutiveFailures = 0;
  row.lastError = null;
  row.currentState = 'SUCCESS';
}

export function notePipelineAgentFailure(agentId: string, err: unknown): void {
  const row = ensure(agentId);
  row.lastFailureAt = Date.now();
  row.consecutiveFailures += 1;
  row.lastError = clipError(err);
  row.currentState = 'FAILED';
}

export function notePipelineAgentGated(agentId: string): void {
  const row = ensure(agentId);
  row.currentState = 'GATED';
}

export function getPipelineAgentHeartbeat(agentId: string): PipelineAgentHeartbeat {
  const row = heartbeats.get(agentId);
  return row ? { ...row } : emptyHeartbeat();
}

export function isPipelineAgentAlive(agentId: string, nowMs: number = Date.now()): boolean {
  const row = getPipelineAgentHeartbeat(agentId);
  if (row.lastTickAt === null) return false;
  return nowMs - row.lastTickAt <= tradingSafety.pipelineAgentDeadAfterMs;
}

export function resetPipelineAgentHealthForTests(): void {
  heartbeats.clear();
}
