/**
 * AI Provider Health Check - three tiers, per the operator's own design:
 *   1. CONFIG   (cheap, no network): is a provider selected, is a credential present and not a
 *      placeholder, is a model configured.
 *   2. AUTH     (real, minimal network request): provider.authenticate() + a tiny "Reply with
 *      exactly: OK" chat call - the exact same probe AIRouter.probeProviderAtStartup() already
 *      runs once at boot, made re-runnable on demand/periodically and classified into a named
 *      status instead of a binary healthy/not.
 *   3. RUNTIME  (tracked over time): last success/failure, consecutive failures, latency - kept in
 *      a small in-memory map owned entirely by this module, updated only by this module's own
 *      checks (startup / periodic / on-demand). Deliberately does NOT hook into AIRouter's live
 *      routeTask()/routeConsensus() call sites - keeps this additive and isolated, and means a
 *      trading agent's own AI call timing/volume never skews this diagnostic's cadence.
 *
 * Zero-Trade Forensic Audit finding this addresses: "Configured: check" was being treated as
 * "healthy" nowhere in code, but there was also no single place that told an operator WHICH
 * provider was actually broken and WHY (auth vs quota vs timeout vs model-not-found) without
 * reading raw ai_calls error strings by hand. This module exists to make that distinction explicit
 * and queryable - it does not change routing, does not change consensus math, and never places or
 * blocks a trade by itself.
 *
 * Never logs, stores, or returns a raw API key - only booleans/classifications derived from the
 * same envKeyForProviderName()/isPlaceholderApiKey() helpers AIRouter.ts already uses.
 */
import { AIRouter, envKeyForProviderName, isPlaceholderApiKey, isAuthFailureError, isUnreachableProviderError, isTimeoutSkipError } from './AIRouter';
import type { AIProvider } from './providers/AIProvider';
import { db } from '../db';
import * as schema from '../db/schema';
import { EncryptionService } from '../core/EncryptionService';
import { runtimeIntervals } from '../config/runtimeIntervals';

export type AIProviderHealthStatus =
  | 'HEALTHY'
  | 'AUTH_FAILED'
  | 'CONFIG_MISSING'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface AIProviderHealthRecord {
  providerId: string;
  providerName: string;
  configured: boolean;
  credentialPresent: boolean;
  /** OPS-1: which credential this provider is actually running on right now - never the value.
   *  'ENV' covers both "no DB key was ever stored" and "DB key was stale and AIRouter's startup
   *  probe already fell back to .env" - see AIRouter.getCredentialSource()'s own doc comment. */
  credentialSource: 'DB' | 'ENV' | 'NONE';
  model: string | null;
  registered: boolean;
  authenticated: boolean;
  status: AIProviderHealthStatus;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /** Sanitized (SecretRedaction-style) message - never the raw key. */
  lastErrorSummary: string | null;
}

interface TrackerEntry {
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastStatus: AIProviderHealthStatus;
  lastErrorSummary: string | null;
}

const tracker = new Map<string, TrackerEntry>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function emptyEntry(): TrackerEntry {
  return {
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastLatencyMs: null,
    lastStatus: 'UNKNOWN',
    lastErrorSummary: null,
  };
}

/** Never the raw key - just enough to distinguish failure classes in logs/UI. */
function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[?&]?api[_-]?key=[^&\s]+/gi, '[REDACTED]').slice(0, 300);
}

/** Additive to AIRouter's own isAuthFailureError/isUnreachableProviderError/isTimeoutSkipError -
 *  those three already exist and are reused verbatim; this adds the remaining distinctions the
 *  operator asked for (quota vs rate-limit vs model-not-found vs generic unreachable). */
function classifyError(err: unknown): AIProviderHealthStatus {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTimeoutSkipError(err)) return 'TIMEOUT';
  if (isAuthFailureError(err)) return 'AUTH_FAILED';
  if (/\b402\b|payment required|quota|insufficient[_ ]?quota|billing/i.test(msg)) return 'QUOTA_EXCEEDED';
  if (/\b429\b|rate[_ -]?limit/i.test(msg)) return 'RATE_LIMITED';
  if (/\b404\b/.test(msg) && /model/i.test(msg)) return 'MODEL_UNAVAILABLE';
  if (isUnreachableProviderError(err)) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN';
}

type HealthCheckOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; status: AIProviderHealthStatus; errorSummary: string };

function recordResult(providerId: string, outcome: HealthCheckOutcome): void {
  const entry = tracker.get(providerId) ?? emptyEntry();
  const now = Date.now();
  entry.lastCheckedAt = now;
  if (outcome.ok === false) {
    entry.lastFailureAt = now;
    entry.consecutiveFailures += 1;
    entry.lastStatus = outcome.status;
    entry.lastErrorSummary = outcome.errorSummary;
  } else {
    entry.lastSuccessAt = now;
    entry.consecutiveFailures = 0;
    entry.lastLatencyMs = outcome.latencyMs;
    entry.lastStatus = 'HEALTHY';
    entry.lastErrorSummary = null;
  }
  tracker.set(providerId, entry);
}

/** Real, minimal network request - same shape as AIRouter's own probeProviderAtStartup(), made
 *  re-runnable. Never throws - a failed check is a recorded status, not an exception. */
export async function checkProviderHealth(providerId: string, provider: AIProvider): Promise<void> {
  const start = Date.now();
  try {
    const authed = await provider.authenticate();
    if (!authed) {
      recordResult(providerId, { ok: false, status: 'AUTH_FAILED', errorSummary: 'authenticate() returned false' });
      return;
    }
    const controller = new AbortController();
    const timeoutMs = 8000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await provider.chat('Reply with exactly: OK', { temperature: 0, signal: controller.signal });
      clearTimeout(timer);
      if (!res.content) {
        recordResult(providerId, { ok: false, status: 'UNKNOWN', errorSummary: 'empty response content' });
        return;
      }
      recordResult(providerId, { ok: true, latencyMs: Date.now() - start });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  } catch (e) {
    recordResult(providerId, { ok: false, status: classifyError(e), errorSummary: sanitizeErrorMessage(e) });
  }
}

/** On-demand trigger (the operator's "Test Provider" button) - runs the real AUTH-tier check now
 *  for one provider (or every currently-registered provider) and returns the refreshed snapshot. */
export async function runAIProviderHealthCheckNow(providerId?: string): Promise<AIProviderHealthRecord[]> {
  const entries = AIRouter.getInstance().listProviders();
  const targets = providerId ? entries.filter(([id]) => id === providerId) : entries;
  await Promise.all(targets.map(([id, provider]) => checkProviderHealth(id, provider)));
  return await getAIProviderHealthSnapshot();
}

/** CONFIG + AUTH + RUNTIME merged into one honest per-provider record. Covers every DB-known
 *  provider row, not just currently-registered ones, so a provider that failed to even register
 *  (e.g. missing credential) still shows up as CONFIG_MISSING rather than silently disappearing.
 *  Always reads DB rows fresh (same per-request cost AIRouter.routeTask/routeConsensus already
 *  pay) rather than depending on the periodic monitor having ticked at least once first. */
export async function getAIProviderHealthSnapshot(): Promise<AIProviderHealthRecord[]> {
  let rows: (typeof schema.aiProviders.$inferSelect)[] = [];
  try {
    rows = await db.select().from(schema.aiProviders);
  } catch {
    return [];
  }
  const registered = new Map(AIRouter.getInstance().listProviders());
  const records: AIProviderHealthRecord[] = [];
  for (const row of rows) {
    let credentialPresent = false;
    try {
      const decrypted = row.apiKeyEncrypted ? EncryptionService.decrypt(row.apiKeyEncrypted) : envKeyForProviderName(row.providerName);
      credentialPresent = !isPlaceholderApiKey(decrypted);
    } catch {
      credentialPresent = false;
    }
    const endpointHint = row.apiEndpoint || '';
    const isLocal = endpointHint.includes('localhost') || endpointHint.includes('127.0.0.1');
    const configured = row.enabled !== false && (isLocal || credentialPresent);
    const isRegistered = registered.has(row.id);
    const t = tracker.get(row.id);

    let status: AIProviderHealthStatus;
    if (!configured) {
      status = 'CONFIG_MISSING';
    } else if (!isRegistered) {
      status = 'PROVIDER_UNAVAILABLE';
    } else if (t) {
      status = t.lastStatus;
    } else {
      status = 'UNKNOWN'; // configured + registered, but no check has run yet this process
    }

    records.push({
      providerId: row.id,
      providerName: row.providerName,
      configured,
      credentialPresent: isLocal || credentialPresent,
      credentialSource: AIRouter.getInstance().getCredentialSource(row.id),
      model: row.defaultModel ?? null,
      registered: isRegistered,
      authenticated: status === 'HEALTHY',
      status,
      latencyMs: t?.lastLatencyMs ?? null,
      lastCheckedAt: t?.lastCheckedAt ? new Date(t.lastCheckedAt).toISOString() : null,
      lastSuccessAt: t?.lastSuccessAt ? new Date(t.lastSuccessAt).toISOString() : (row.lastSuccess ?? null),
      lastFailureAt: t?.lastFailureAt ? new Date(t.lastFailureAt).toISOString() : (row.lastFailure ?? null),
      consecutiveFailures: t?.consecutiveFailures ?? 0,
      lastErrorSummary: t?.lastErrorSummary ?? null,
    });
  }
  return records;
}

/** Startup + periodic. Safe to call multiple times (idempotent no-op if already running). Runs
 *  one immediate check (the "startup" tier) before scheduling the periodic tier. */
export function startAIProviderHealthMonitor(): void {
  if (intervalId) return;
  void tick();
  intervalId = setInterval(() => { void tick(); }, runtimeIntervals.aiProviderHealthCheckMs);
}

export function stopAIProviderHealthMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function tick(): Promise<void> {
  const entries = AIRouter.getInstance().listProviders();
  await Promise.all(entries.map(([id, provider]) => checkProviderHealth(id, provider)));
}

/** Test-only - clears in-memory tracker without touching AIRouter's own state. */
export function resetAIProviderHealthTrackerForTests(): void {
  tracker.clear();
  stopAIProviderHealthMonitor();
}
