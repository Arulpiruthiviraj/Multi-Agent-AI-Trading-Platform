/**
 * Active-integration selection routes: which market-data adapter and which
 * broker are currently active, and switching between the registered ones.
 * Extracted from server.ts structurally only — behavior is unchanged.
 */
import { Router, Request, Response } from "express";
import { MarketDataManager } from "../../marketdata/MarketDataManager";
import { BrokerManager } from "../../brokers/BrokerManager";

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

integrationRouter.post("/brokers/active", async (req: Request, res: Response) => {
  const { id, credentials } = req.body;
  try {
    const success = await BrokerManager.getInstance().setActiveBroker(id, credentials);
    res.json({ success });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});
