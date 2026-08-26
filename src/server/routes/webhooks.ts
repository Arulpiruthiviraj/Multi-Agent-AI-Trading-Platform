/**
 * Outbound webhook configuration and dispatch.
 *
 * Extracted from server.ts (structural refactor only — behavior is unchanged):
 * - Manages the in-memory list of configured outbound webhooks (Slack/Discord/generic).
 * - Exposes CRUD + test-send routes, mounted at /api/v1/webhooks in server.ts.
 * - Exposes `triggerWebhooks()`. The legacy /api/v1/signals risk-veto caller is quarantined;
 *   remaining callers are explicit webhook test/dispatch routes.
 */
import { Router, Request, Response } from "express";
import { isSafeOutboundUrl } from "../core/urlSafety";
import { withTimeout } from "../services/brokerPortfolioResponse";

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
  type: "veto" | "daily_loss_breach" | "sector_exposure_breach"
      // Phase 12 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real CRITICAL alert categories, wired
      // to real EventBus events for the first time by AlertingService.ts. Additive to the
      // pre-existing union - the 3 original values and their behavior are unchanged.
      | "reconciliation_mismatch" | "market_data_disconnected" | "trading_state_changed" | "ai_providers_exhausted"
      | "order_executed" | "process_boot"
      | "external_manual_order";
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
 * Dispatches a real-time notification to every enabled webhook subscribed to the
 * given event type (or subscribed to "all"). Formats the payload per webhook `type`
 * (Slack `text`, Discord `embeds`, otherwise the raw event + timestamp).
 */
export async function triggerWebhooks(event: WebhookEvent): Promise<void> {
  console.log(`[Webhook Trigger] Event: ${event.type} | ${event.title}`);
  for (const wh of webhooks) {
    if (!wh.enabled) continue;
    if (wh.events.includes("all") || wh.events.includes(event.type)) {
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
      // Real bug found and fixed this pass: fetch() is deliberately not awaited (dispatch must
      // not block the real-time event path on a slow/unreliable external webhook endpoint), but
      // that also means the surrounding try/catch could only ever catch a synchronous throw from
      // calling fetch() itself - never the rejected promise a real DNS failure, connection
      // refusal, or TLS error produces. That was a genuine unhandled promise rejection on every
      // enabled webhook for every real safety-relevant event (veto, daily_loss_breach, ...).
      try {
        fetch(wh.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
          .catch((e) => console.error(`[Webhook] Dispatch to ${wh.name} failed:`, e?.message || e));
      } catch (e) {}
    }
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
  // lookup to the hot event-notification path.
  const safety = await isSafeOutboundUrl(url);
  if (!safety.safe) return res.status(400).json({ error: `Unsafe webhook URL: ${safety.reason}` });
  const newWh: Webhook = {
    id: "wh_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    name,
    url,
    type: type || "slack",
    enabled: enabled ?? true,
    events: events || ["all"],
    createdAt: new Date().toISOString(),
  };
  webhooks.push(newWh);
  res.json(newWh);
});

webhooksRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const wh = webhooks.find((w) => w.id === id);
  if (!wh) return res.status(404).json({ error: "Not found" });
  if (req.body.url !== undefined) {
    const safety = await isSafeOutboundUrl(req.body.url);
    if (!safety.safe) return res.status(400).json({ error: `Unsafe webhook URL: ${safety.reason}` });
    wh.url = req.body.url;
  }
  if (req.body.enabled !== undefined) wh.enabled = req.body.enabled;
  if (req.body.name !== undefined) wh.name = req.body.name;
  if (req.body.events !== undefined) wh.events = req.body.events;
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
    // Real defect fixed (2026-08-26 comprehensive remediation pass): `url` is an arbitrary
    // caller-supplied endpoint with NO timeout at all - a slow/hanging destination could run past
    // server.ts's global 15s per-request backstop, which sends its own response first, then this
    // handler's late resolution would try to send a second one, throwing ERR_HTTP_HEADERS_SENT
    // (the same root cause already fixed twice in v2System.ts this session). Bound to 5s (well
    // under the 15s backstop) and guard both response sites, matching that reviewed pattern.
    const response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      }),
      5000,
      'webhook test POST',
    );
    if (!res.headersSent) res.json({ success: response.ok, status: response.status });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
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
