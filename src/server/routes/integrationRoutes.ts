/**
 * Active-integration selection routes: which market-data adapter and which
 * broker are currently active, and switching between the registered ones.
 * Extracted from server.ts structurally only — behavior is unchanged.
 */
import { Router, Request, Response } from "express";
import { MarketDataManager } from "../../marketdata/MarketDataManager";
import { BrokerManager } from "../../brokers/BrokerManager";
import { db } from "../db";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";

export const integrationRouter = Router();

integrationRouter.get("/marketdata/adapters", (req: Request, res: Response) => {
  res.json({
    adapters: MarketDataManager.getInstance().getAvailableAdapters(),
    activeAdapter: MarketDataManager.getInstance().getActiveAdapter().id,
  });
});

integrationRouter.post("/marketdata/active", async (req: Request, res: Response) => {
  const { id, credentials } = req.body;
  try {
    const success = await MarketDataManager.getInstance().setActiveAdapter(id, credentials);
    res.json({ success });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});

integrationRouter.get("/brokers", (req: Request, res: Response) => {
  res.json({
    brokers: BrokerManager.getInstance().getAvailableBrokers(),
    activeBroker: BrokerManager.getInstance().getActiveBroker().id,
  });
});

// Same data as GET /brokers above, at a path that doesn't collide. configRoutes.ts's own
// unrelated `configRouter.get('/brokers', ...)` is ALSO mounted at bare /api/v1 (a pre-existing
// duplicate-mount defect - see the audit) and wins over this router's /brokers for that exact
// path, so this real capability-model endpoint was completely unreachable. Not fixing the
// underlying duplicate mount here (out of scope for this change) - just giving this data a path
// that actually resolves.
integrationRouter.get("/broker-capabilities", (req: Request, res: Response) => {
  res.json({
    brokers: BrokerManager.getInstance().getAvailableBrokers(),
    activeBroker: BrokerManager.getInstance().getActiveBroker().id,
  });
});

// Real, non-mutating connection test - never changes the active broker. Calls the adapter's own
// authenticate()/health() and returns exactly what came back, including the real failure reason.
integrationRouter.post("/brokers/:id/test", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { credentials } = req.body || {};
  const result = await BrokerManager.getInstance().testConnection(id, credentials);
  res.json(result);
});

// The real paper->live promotion path - see BrokerManager.setLiveMode() for why this didn't
// exist before (nothing ever set brokerConnections.paperMode to false).
integrationRouter.post("/brokers/:id/live-mode", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { live, confirm } = req.body || {};
  const result = await BrokerManager.getInstance().setLiveMode(id, !!live, confirm);
  res.status(result.ok ? 200 : 400).json(result);
});

integrationRouter.post("/brokers/active", async (req: Request, res: Response) => {
  const { id, credentials } = req.body;
  try {
    const success = await BrokerManager.getInstance().setActiveBroker(id, credentials);
    if (success) {
      // Persist so this survives a restart - previously the runtime switch was in-memory only
      // and BrokerManager.initialize() would silently revert to the last-saved settings row on
      // next boot, undoing whatever the user had just selected here.
      const activeName = BrokerManager.getInstance().getActiveBroker().name;
      const existing = await db.select().from(schema.settings).limit(1);
      if (existing.length > 0) {
        await db.update(schema.settings).set({ selectedBroker: activeName }).where(eq(schema.settings.id, existing[0].id));
      }
    }
    res.json({ success });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});
