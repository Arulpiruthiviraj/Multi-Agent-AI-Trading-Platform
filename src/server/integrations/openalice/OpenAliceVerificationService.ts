/**
 * ==========================================================
 * Module: OpenAliceVerificationService
 *
 * Purpose:
 * Singleton orchestrating OpenAlice verification requests: persists every request/result to
 * the openalice_verifications table, runs a background poll loop against the OpenAlice inbox,
 * and emits OPENALICE_VERIFICATION_* EventBus events. This is the ONLY place that talks to
 * OpenAliceAdapter - callers (ChiefTraderAgent, EscalationPolicy) never see MCP details.
 *
 * Disabled by default. Enable with OPENALICE_ENABLED=true and OPENALICE_MCP_URL=<url>. When
 * disabled, requestVerification() is a durable no-op (never throws, never blocks a caller) -
 * matching the project convention of graceful, honestly-reported absence rather than a crash.
 *
 * NOT live-verified against a real running OpenAlice instance - no instance exists in this
 * environment. The request-building, persistence, and inbox-parsing logic is unit-tested
 * against a mocked adapter instead (see OpenAliceVerificationService.test.ts).
 * ==========================================================
 */
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import * as schema from '../../db/schema';
import { eventBus } from '../../core/EventBus';
import { OpenAliceAdapter } from './OpenAliceAdapter';
import type {
  VerificationHealth,
  VerificationMode,
  VerificationRequest,
  VerificationResult,
} from './types';

const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000; // matches the audit's own latency finding: viable only non-blocking, can take hours
const GUARDIAN_MCP_URL = 'http://127.0.0.1:47332/mcp';

export class OpenAliceVerificationService {
  private static instance: OpenAliceVerificationService;

  readonly enabled: boolean;
  private adapter: OpenAliceAdapter | null = null;
  private activeMcpUrl: string | null = null;
  private readonly pending = new Map<string, VerificationRequest>();
  private pollTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.enabled = process.env.OPENALICE_ENABLED === 'true';
    if (this.enabled) {
      const url = process.env.OPENALICE_MCP_URL;
      if (!url) {
        console.warn('[OpenAlice] OPENALICE_ENABLED=true but OPENALICE_MCP_URL is not set - disabling.');
        (this as any).enabled = false;
      } else {
        this.activeMcpUrl = url;
        this.adapter = new OpenAliceAdapter(url);
        console.log('[OpenAlice] Verification service enabled. Will not poll a trading MCP; Guardian tools required.');
      }
    }
  }

  static getInstance(): OpenAliceVerificationService {
    if (!OpenAliceVerificationService.instance) {
      OpenAliceVerificationService.instance = new OpenAliceVerificationService();
    }
    return OpenAliceVerificationService.instance;
  }

  get mcpUrl(): string | null {
    return this.activeMcpUrl;
  }

  async health(): Promise<VerificationHealth> {
    if (!this.enabled || !this.adapter) {
      return { reachable: false, detail: 'OpenAlice integration disabled (OPENALICE_ENABLED != true)', checkedAt: new Date().toISOString() };
    }
    const primary = await this.adapter.healthCheck();
    if (primary.reachable) {
      this.ensurePolling();
      return primary;
    }

    const keepConfigured = process.env.ARGUS_KEEP_OPENALICE_MCP_URL === 'true';
    const configured = (process.env.OPENALICE_MCP_URL || '').replace(/\/$/, '');
    const guardian = GUARDIAN_MCP_URL.replace(/\/$/, '');
    if (keepConfigured || configured === guardian) {
      return primary;
    }

    const fallback = new OpenAliceAdapter(GUARDIAN_MCP_URL);
    const secondary = await fallback.healthCheck();
    if (secondary.reachable) {
      this.adapter = fallback;
      this.activeMcpUrl = GUARDIAN_MCP_URL;
      this.ensurePolling();
      console.warn(`[OpenAlice] Configured MCP lacked Guardian tools (issue_create/inbox_read). Switched to ${GUARDIAN_MCP_URL}. Trading MCP tools are never called.`);
      return {
        ...secondary,
        detail: `${secondary.detail} (switched from a non-Guardian MCP to ${GUARDIAN_MCP_URL})`,
      };
    }

    return {
      reachable: false,
      detail: `${primary.detail} Guardian fallback ${GUARDIAN_MCP_URL}: ${secondary.detail}`,
      checkedAt: secondary.checkedAt,
    };
  }

  private ensurePolling() {
    if (this.pollTimer) return;
    this.startPolling();
    console.log('[OpenAlice] Inbox poll started every', POLL_INTERVAL_MS / 1000, 's');
  }

  /**
   * Fire-and-forget: persists a PENDING row and files the OpenAlice issue in the background.
   * Never awaited by a caller on the decision path - errors are caught and recorded, never thrown.
   */
  requestVerification(params: {
    traceId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    mode: VerificationMode;
    argusConfidence: number;
    argusReasoning: string;
  }): void {
    if (!this.enabled || !this.adapter) return;

    const request: VerificationRequest = {
      requestId: uuidv4(),
      traceId: params.traceId,
      symbol: params.symbol,
      side: params.side,
      mode: params.mode,
      argusConfidence: params.argusConfidence,
      argusReasoning: params.argusReasoning,
      createdAt: new Date().toISOString(),
    };

    this.pending.set(request.requestId, request);

    db.insert(schema.openaliceVerifications).values({
      id: request.requestId,
      traceId: request.traceId,
      symbol: request.symbol,
      side: request.side,
      mode: request.mode,
      argusConfidence: request.argusConfidence,
      argusReasoning: request.argusReasoning,
      status: 'PENDING',
      createdAt: request.createdAt,
    }).catch((e) => console.error('[OpenAlice] Failed to persist verification request', e));

    void this.health().then(async (h): Promise<void> => {
      if (!h.reachable || !this.adapter) {
        console.warn('[OpenAlice] Skipping verification file — Guardian MCP not reachable:', h.detail);
        this.pending.delete(request.requestId);
        await db.update(schema.openaliceVerifications)
          .set({ status: 'FAILED', error: h.detail, completedAt: new Date().toISOString() })
          .where(eq(schema.openaliceVerifications.id, request.requestId));
        return;
      }
      await this.adapter.requestVerification(request);
      eventBus.publish('OPENALICE_VERIFICATION_REQUESTED', {
        traceId: request.traceId,
        requestId: request.requestId,
        symbol: request.symbol,
        side: request.side,
        mode: request.mode,
      });
    }).catch((e) => {
      console.error('[OpenAlice] Failed to file verification request', e);
      this.pending.delete(request.requestId);
      db.update(schema.openaliceVerifications)
        .set({ status: 'FAILED', error: String(e?.message ?? e), completedAt: new Date().toISOString() })
        .where(eq(schema.openaliceVerifications.id, request.requestId))
        .catch((err) => console.error('[OpenAlice] Failed to record request failure', err));
    });
  }

  private startPolling() {
    this.pollTimer = setInterval(() => this.pollOnce().catch((e) => console.error('[OpenAlice] Poll cycle failed', e)), POLL_INTERVAL_MS);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    if (!this.adapter || this.pending.size === 0) return;

    const now = Date.now();
    for (const [requestId, request] of this.pending) {
      if (now - new Date(request.createdAt).getTime() > REQUEST_TIMEOUT_MS) {
        this.pending.delete(requestId);
        await db.update(schema.openaliceVerifications)
          .set({ status: 'TIMED_OUT', completedAt: new Date().toISOString() })
          .where(eq(schema.openaliceVerifications.id, requestId));
        eventBus.publish('OPENALICE_VERIFICATION_TIMED_OUT', { traceId: request.traceId, requestId, symbol: request.symbol });
      }
    }
    if (this.pending.size === 0) return;

    const results = await this.adapter.pollForReports(new Set(this.pending.keys()));
    for (const [requestId, partial] of results) {
      const request = this.pending.get(requestId);
      if (!request) continue;
      this.pending.delete(requestId);

      const receivedAt = new Date().toISOString();
      const result: VerificationResult = {
        ...partial,
        requestId,
        traceId: request.traceId,
        symbol: request.symbol,
        receivedAt,
        latencyMs: Date.now() - new Date(request.createdAt).getTime(),
      };

      await db.update(schema.openaliceVerifications)
        .set({
          status: 'COMPLETED',
          direction: result.direction,
          openaliceConfidence: result.confidence,
          thesis: result.thesis,
          supportingEvidence: JSON.stringify(result.supportingEvidence),
          contradictingEvidence: JSON.stringify(result.contradictingEvidence),
          rawResponse: result.raw,
          completedAt: receivedAt,
          latencyMs: result.latencyMs,
        })
        .where(eq(schema.openaliceVerifications.id, requestId));

      eventBus.publish('OPENALICE_VERIFICATION_COMPLETED', {
        traceId: result.traceId,
        requestId,
        symbol: result.symbol,
        direction: result.direction,
        confidence: result.confidence,
        thesis: result.thesis,
        latencyMs: result.latencyMs,
      });
    }
  }

  /** For tests/diagnostics: recent verification rows for a symbol, most recent first. */
  async recentForSymbol(symbol: string, limit = 10) {
    return db.select().from(schema.openaliceVerifications)
      .where(eq(schema.openaliceVerifications.symbol, symbol))
      .orderBy(schema.openaliceVerifications.createdAt)
      .limit(limit);
  }
}

export const openAliceVerificationService = OpenAliceVerificationService.getInstance();
