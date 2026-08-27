/**
 * Phase 9 (2026-08-27) - a real, queryable per-provider health matrix. Prior state was only
 * inferable from aggregate counters (`/api/v2/runtime/health`'s `aiProviderHealth.statuses`
 * bucket counts) or by reading raw ai_calls rows by hand. This joins the DB's all-time
 * `ai_providers` row with a recent window of real `ai_calls` outcomes and AIRouter's live
 * in-memory routing snapshot (skip/auth-disabled cooldowns) - never a new live probe that would
 * burn real provider quota just to build a report.
 */
import { db } from '../db';
import { aiProviders, aiCalls } from '../db/schema';
import { desc, gte } from 'drizzle-orm';
import { AIRouter } from '../ai/AIRouter';

export type ProviderRoutingState = 'ACTIVE' | 'AUTH_DISABLED' | 'SKIPPED';

export interface ProviderHealthRow {
  providerId: string;
  providerName: string;
  hasApiKey: boolean;
  defaultModel: string | null;
  dbHealth: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  recentCallCount: number;
  recentSuccessCount: number;
  recentErrorCount: number;
  recentSuccessRate: number | null;
  avgLatencyMs: number | null;
  mostRecentError: string | null;
  routingState: ProviderRoutingState;
  routingCooldownRemainingMs: number | null;
}

/** `recentWindowMs` bounds how far back into ai_calls to look for the recent-outcome columns. */
export async function buildProviderHealthMatrix(now: Date = new Date(), recentWindowMs = 6 * 60 * 60 * 1000): Promise<ProviderHealthRow[]> {
  const providers = await db.select().from(aiProviders);
  const sinceIso = new Date(now.getTime() - recentWindowMs).toISOString();
  const recentCalls = await db.select().from(aiCalls).where(gte(aiCalls.createdAt, sinceIso)).orderBy(desc(aiCalls.createdAt));

  const byProvider = new Map<string, typeof recentCalls>();
  for (const c of recentCalls) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider)!.push(c);
  }

  const routingSnapshot = new Map(AIRouter.getInstance().getProviderRoutingSnapshot().map((r) => [r.providerId, r]));
  const nowMs = now.getTime();

  return providers.map((p) => {
    const calls = byProvider.get(p.id) ?? [];
    const successCalls = calls.filter((c) => c.status === 'success');
    const errorCalls = calls.filter((c) => c.status === 'error');
    const latencies = calls.map((c) => c.latencyMs).filter((l): l is number => typeof l === 'number');
    const routing = routingSnapshot.get(p.id);

    let routingState: ProviderRoutingState = 'ACTIVE';
    let routingCooldownRemainingMs: number | null = null;
    if (routing?.authDisabledUntil && routing.authDisabledUntil > nowMs) {
      routingState = 'AUTH_DISABLED';
      routingCooldownRemainingMs = routing.authDisabledUntil - nowMs;
    } else if (routing?.skipUntil && routing.skipUntil > nowMs) {
      routingState = 'SKIPPED';
      routingCooldownRemainingMs = routing.skipUntil - nowMs;
    }

    return {
      providerId: p.id,
      providerName: p.providerName,
      hasApiKey: !!p.apiKeyEncrypted,
      defaultModel: p.defaultModel,
      dbHealth: p.health,
      lastSuccess: p.lastSuccess,
      lastFailure: p.lastFailure,
      recentCallCount: calls.length,
      recentSuccessCount: successCalls.length,
      recentErrorCount: errorCalls.length,
      recentSuccessRate: calls.length > 0 ? successCalls.length / calls.length : null,
      avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      mostRecentError: errorCalls[0]?.error ?? null,
      routingState,
      routingCooldownRemainingMs,
    };
  });
}
