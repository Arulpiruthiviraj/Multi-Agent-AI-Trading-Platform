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

integrationRouter.post("/brokers/active", async (req: Request, res: Response) => {
  const { id, credentials } = req.body;
  try {
    const success = await BrokerManager.getInstance().setActiveBroker(id, credentials);
    res.json({ success });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});
