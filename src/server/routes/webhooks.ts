/**
 * Outbound webhook configuration and dispatch.
 *
 * Extracted from server.ts (structural refactor only — behavior is unchanged):
 * - Manages the in-memory list of configured outbound webhooks (Slack/Discord/generic).
 * - Exposes CRUD + test-send routes, mounted at /api/v1/webhooks in server.ts.
 * - Exposes `triggerWebhooks()`. The legacy /api/v1/signals risk-veto caller is quarantined;
 *   remaining callers are explicit webhook test/dispatch routes.
 *
 * F29/F31/F32 remediation (ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md):
 *   F29 - both the real dispatch path (triggerWebhooks) and the manual test route now go through
 *         safeFetch.ts, which re-validates the actual connection target at connect time (including
 *         every redirect hop), not only the URL string at configuration time.
 *   F31 - create/update payloads are validated against a fixed event-type enum, known webhook
 *         type, and boolean `enabled` shape before being stored, and rejected atomically. One
 *         malformed legacy/stored config can no longer throw inside the dispatch loop.
 *   F32 - dispatch applies a config-driven bounded timeout (via safeFetch), records non-2xx HTTP
 *         responses as failures rather than silent success, and bounds total in-flight deliveries
 *         so a hung receiver cannot let concurrent outbound sockets grow unbounded.
 */
import { Router, Request, Response } from "express";
import { isSafeOutboundUrl } from "../core/urlSafety";
import { safeFetch, SafeFetchBlockedError } from "../core/safeFetch";
import { withTimeout } from "../services/brokerPortfolioResponse";
import { tradingSafety } from "../config/tradingSafety";

/** Canonical webhook event-type enum (F31). Kept as a runtime array (not just the TS union below)
 *  so create/update validation has something real to check incoming JSON against - a TS union
 *  alone gives no runtime protection. Add new event types here first, matching WebhookEvent.type. */
export const WEBHOOK_EVENT_TYPES = [
  "veto",
  "daily_loss_breach",
  "sector_exposure_breach",
  "reconciliation_mismatch",
  "market_data_disconnected",
  "trading_state_changed",
  "ai_providers_exhausted",
  "order_executed",
  "process_boot",
  "external_manual_order",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WEBHOOK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);
const WEBHOOK_TYPES = ["slack", "discord", "generic"] as const;
const WEBHOOK_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_TYPES);

export interface Webhook {
  id: string;
  name: string;
  url: string;
  type: "slack" | "discord" | "generic";
  enabled: boolean;
  events: string[];
  createdAt: string;
}

export interface WebhookEvent {
  type: WebhookEventType;
  title: string;
  message: string;
  details?: Record<string, unknown>;
}

// Global custom outbound webhooks configuration
const webhooks: Webhook[] = [
  {
    id: "wh_slack_sample",
    name: "Slack Desk channel",
    url: "https://hooks.slack.com/services/T00/B00/X123",
    type: "slack",
    enabled: false,
    events: ["veto", "daily_loss_breach", "sector_exposure_breach"],
    createdAt: new Date().toISOString(),
  },
];

/**
 * F31: validates a candidate `events` field for create/update. Accepts either `["all"]`/mixed
 * with "all", or an array of values drawn from WEBHOOK_EVENT_TYPES. Rejects non-arrays (object,
 * number, string, null) and arrays containing anything outside the known enum - this is exactly
 * the shape that previously reached dispatch's `.includes` call unchecked and could throw
 * (object/number) or match unintended substrings (a bare string coerced through `.includes`).
 */
function validateEvents(events: unknown): { valid: true; events: string[] } | { valid: false; reason: string } {
  if (!Array.isArray(events)) {
    return { valid: false, reason: `"events" must be an array of event type strings, got ${typeof events}.` };
  }
  for (const e of events) {
    if (typeof e !== "string") {
      return { valid: false, reason: `"events" entries must be strings, found ${typeof e}.` };
    }
    if (e !== "all" && !WEBHOOK_EVENT_TYPE_SET.has(e)) {
      return { valid: false, reason: `Unsupported webhook event type "${e}".` };
    }
  }
  return { valid: true, events };
}

function validateWebhookType(type: unknown): { valid: true; type: Webhook["type"] } | { valid: false; reason: string } {
  if (type === undefined) return { valid: true, type: "slack" };
  if (typeof type !== "string" || !WEBHOOK_TYPE_SET.has(type)) {
    return { valid: false, reason: `Unsupported webhook type "${type}". Must be one of: ${WEBHOOK_TYPES.join(", ")}.` };
  }
  return { valid: true, type: type as Webhook["type"] };
}

function validateEnabled(enabled: unknown): { valid: true; enabled: boolean } | { valid: false; reason: string } {
  if (enabled === undefined) return { valid: true, enabled: true };
  if (typeof enabled !== "boolean") {
    return { valid: false, reason: `"enabled" must be a boolean, got ${typeof enabled}.` };
  }
  return { valid: true, enabled };
}

/**
 * F32: bounds the number of outbound webhook deliveries in flight at once across the whole
 * process, so a slow/hung receiver (or a burst of many real safety events) cannot let concurrent
 * open sockets grow without limit. Config-driven (tradingSafety.json `webhookDispatchMaxConcurrency`)
 * rather than a hardcoded literal.
 */
class BoundedConcurrencyQueue {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const dispatchQueue = new BoundedConcurrencyQueue(Math.max(1, tradingSafety.webhookDispatchMaxConcurrency));

/**
 * Dispatches a real-time notification to every enabled webhook subscribed to the
 * given event type (or subscribed to "all"). Formats the payload per webhook `type`
 * (Slack `text`, Discord `embeds`, otherwise the raw event + timestamp).
 */
export async function triggerWebhooks(event: WebhookEvent): Promise<void> {
  console.log(`[Webhook Trigger] Event: ${event.type} | ${event.title}`);
  for (const wh of webhooks) {
    if (!wh.enabled) continue;
    // F31: `wh.events` is guaranteed valid (enum-checked) at this point because creation/update
    // now reject anything else atomically - but guard defensively anyway in case an
    // already-stored legacy record predates that validation, so one bad record's `.includes`
    // call can never throw and abort delivery to every OTHER webhook in this loop.
    let subscribed: boolean;
    try {
      subscribed = Array.isArray(wh.events) && (wh.events.includes("all") || wh.events.includes(event.type));
    } catch {
      subscribed = false;
    }
    if (!subscribed) continue;

    let payload: Record<string, unknown> = {};
    const timestamp = new Date().toISOString();
    if (wh.type === "slack") {
      payload = {
        text: `🚨 *[ARGUS RISK ALERT]* *${event.title}*\n> ${event.message}\n_Time: ${timestamp}_`,
      };
    } else if (wh.type === "discord") {
      payload = {
        embeds: [
          {
            title: `🚨 [ARGUS RISK ALERT] ${event.title}`,
            description: event.message,
            color: 16711680,
            timestamp,
            footer: { text: "Argus Terminal Oversight Node" },
          },
        ],
      };
    } else {
      payload = { ...event, timestamp };
    }

    // F29/F32: dispatch is deliberately not awaited by the caller (the real-time event path must
    // not block on a slow/unreliable external webhook endpoint), but the delivery itself now runs
    // through the bounded concurrency queue + safeFetch's connect-time SSRF re-check + config-driven
    // timeout, and inspects the HTTP status rather than treating any non-throwing response as
    // success. Each webhook's delivery is independently try/caught so one failing/misconfigured
    // webhook can never affect delivery to any other webhook in this same loop.
    dispatchQueue
      .run(async () => {
        const response = await safeFetch(wh.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          timeoutMs: tradingSafety.webhookDispatchTimeoutMs,
          maxRedirects: tradingSafety.webhookMaxRedirects,
        });
        if (!response.ok) {
          console.error(`[Webhook] Dispatch to ${wh.name} recorded as failed: HTTP ${response.status}`);
        }
        return response;
      })
      .catch((e) => {
        const reason = e instanceof SafeFetchBlockedError ? `blocked by SSRF policy: ${e.message}` : (e?.message || e);
        console.error(`[Webhook] Dispatch to ${wh.name} failed:`, reason);
      });
  }
}

export const webhooksRouter = Router();

webhooksRouter.get("/", (req: Request, res: Response) => {
  res.json(webhooks);
});

webhooksRouter.post("/", async (req: Request, res: Response) => {
  const { name, url, type, enabled, events } = req.body;
  if (!name || !url) return res.status(400).json({ error: "Name and URL required" });
  // Real bug fixed: a stored webhook URL is auto-fetched by triggerWebhooks() on every future
  // real trading/system event, not just once - an unvalidated URL here was a standing SSRF
  // vector, not a one-time test. Validated on write (not on every trigger) to avoid adding a DNS
  // lookup to the hot event-notification path. Connection-time re-validation (F29) happens in
  // safeFetch at actual dispatch time regardless.
  const safety = await isSafeOutboundUrl(url);
  if (!safety.safe) return res.status(400).json({ error: `Unsafe webhook URL: ${safety.reason}` });

  // F31: validate type/events/enabled shape atomically before ever constructing/storing the
  // record - a malformed payload is rejected outright, never partially applied.
  const typeCheck = validateWebhookType(type);
  if (!typeCheck.valid) return res.status(400).json({ error: typeCheck.reason });
  const eventsCheck = validateEvents(events !== undefined ? events : ["all"]);
  if (!eventsCheck.valid) return res.status(400).json({ error: eventsCheck.reason });
  const enabledCheck = validateEnabled(enabled);
  if (!enabledCheck.valid) return res.status(400).json({ error: enabledCheck.reason });

  const newWh: Webhook = {
    id: "wh_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    name,
    url,
    type: typeCheck.type,
    enabled: enabledCheck.enabled,
    events: eventsCheck.events,
    createdAt: new Date().toISOString(),
  };
  webhooks.push(newWh);
  res.json(newWh);
});

webhooksRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const wh = webhooks.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: "Not found" });

  // F31: validate every provided field BEFORE mutating anything, so a partially-invalid update
  // (e.g. a valid new name alongside a malformed `events`) is rejected atomically rather than
  // applying the valid fields and silently dropping/breaking the invalid one.
  let nextUrl: string | undefined;
  if (req.body.url !== undefined) {
    const safety = await isSafeOutboundUrl(req.body.url);
    if (!safety.safe) return res.status(400).json({ error: `Unsafe webhook URL: ${safety.reason}` });
    nextUrl = req.body.url;
  }
  let nextEvents: string[] | undefined;
  if (req.body.events !== undefined) {
    const eventsCheck = validateEvents(req.body.events);
    if (!eventsCheck.valid) return res.status(400).json({ error: eventsCheck.reason });
    nextEvents = eventsCheck.events;
  }
  let nextEnabled: boolean | undefined;
  if (req.body.enabled !== undefined) {
    const enabledCheck = validateEnabled(req.body.enabled);
    if (!enabledCheck.valid) return res.status(400).json({ error: enabledCheck.reason });
    nextEnabled = enabledCheck.enabled;
  }
  let nextType: Webhook["type"] | undefined;
  if (req.body.type !== undefined) {
    const typeCheck = validateWebhookType(req.body.type);
    if (!typeCheck.valid) return res.status(400).json({ error: typeCheck.reason });
    nextType = typeCheck.type;
  }
  let nextName: string | undefined;
  if (req.body.name !== undefined) {
    if (typeof req.body.name !== "string" || !req.body.name) {
      return res.status(400).json({ error: '"name" must be a non-empty string.' });
    }
    nextName = req.body.name;
  }

  // All provided fields validated - apply atomically.
  if (nextUrl !== undefined) wh.url = nextUrl;
  if (nextEnabled !== undefined) wh.enabled = nextEnabled;
  if (nextName !== undefined) wh.name = nextName;
  if (nextEvents !== undefined) wh.events = nextEvents;
  if (nextType !== undefined) wh.type = nextType;
  res.json(wh);
});

webhooksRouter.post("/test", async (req: Request, res: Response) => {
  const { url, type } = req.body;
  const safety = await isSafeOutboundUrl(url);
  if (!safety.safe) return res.status(400).json({ error: `Unsafe webhook URL: ${safety.reason}` });
  let payload: Record<string, unknown> = {};
  const timestamp = new Date().toISOString();

  if (type === "slack") {
    payload = {
      text: `🚨 *[ARGUS RISK ALERT TEST]* *Connection Test*\n> This is a test notification.\n_Time: ${timestamp}_`,
    };
  } else if (type === "discord") {
    payload = {
      embeds: [
        {
          title: `🚨 [ARGUS RISK ALERT TEST] Connection Test`,
          description: "This is a test notification.",
          color: 3066993,
          timestamp,
          footer: { text: "Argus Terminal Oversight Node" },
        },
      ],
    };
  } else {
    payload = { event: "test", timestamp };
  }

  try {
    // F29/F32: the test route previously used an ordinary redirect-following fetch bounded only
    // by its own timeout - no connection-time SSRF re-check, and no non-2xx failure reporting.
    // Now goes through the exact same safeFetch transport (and the exact same config-driven
    // timeout) as real dispatch, so this route can no longer diverge from ordinary event delivery.
    const response = await withTimeout(
      safeFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: tradingSafety.webhookDispatchTimeoutMs,
        maxRedirects: tradingSafety.webhookMaxRedirects,
      }),
      tradingSafety.webhookDispatchTimeoutMs,
      'webhook test POST',
    );
    if (!res.headersSent) res.json({ success: response.ok, status: response.status });
  } catch (err: any) {
    if (!res.headersSent) {
      const status = err instanceof SafeFetchBlockedError ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  }
});

webhooksRouter.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const index = webhooks.findIndex((wh) => wh.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Webhook not found" });
  }
  webhooks.splice(index, 1);
  res.json({ success: true });
});
