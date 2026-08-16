/**
 * Chaos-engineering routes: latency/error injection config for diagnostics,
 * plus synthetic macro-shock injection/clear.
 * Extracted from server.ts structurally only — behavior is unchanged.
 *
 * `chaosConfig` remains exported for the chaos HTTP API. GET /api/v1/signals is
 * quarantined and no longer reads this config.
 */
import { Router, Request, Response } from "express";
import { tradingEngine } from "../engines/TradingEngine";
import { auditLog } from "../core/auditLog";
import { generateContentWithRetry, cleanAndParseJSON } from "../ai/legacyGeminiHelpers";

export interface ChaosConfig {
  enabled: boolean;
  latencyMin: number;
  latencyMax: number;
  errorRate: number;
  selectedAgents: string[];
}

export const chaosConfig: ChaosConfig = { enabled: false, latencyMin: 0, latencyMax: 0, errorRate: 0, selectedAgents: ["all"] };

/**
 * Appends one line to tradingEngine.state.history, capped at 100 entries.
 * (Deduplicated from four identical inline blocks in the original macro-shock
 * handlers — pure dead-code cleanup, no behavior change.)
 */
function logSyntheticEvent(msg: string): void {
  const eventTime = new Date().toISOString();
  tradingEngine.state.history.unshift({ time: eventTime, type: "info", msg });
  if (tradingEngine.state.history.length > 100) tradingEngine.state.history = tradingEngine.state.history.slice(0, 100);
}

export const chaosRouter = Router();

chaosRouter.get("/config", (req: Request, res: Response) => {
  res.json(chaosConfig);
});

chaosRouter.post("/config", (req: Request, res: Response) => {
  const { enabled, latencyMin, latencyMax, errorRate, selectedAgents } = req.body;

  if (enabled !== undefined) chaosConfig.enabled = !!enabled;
  if (latencyMin !== undefined) chaosConfig.latencyMin = Number(latencyMin);
  if (latencyMax !== undefined) chaosConfig.latencyMax = Number(latencyMax);
  if (errorRate !== undefined) chaosConfig.errorRate = Number(errorRate);
  if (selectedAgents !== undefined) chaosConfig.selectedAgents = selectedAgents;

  auditLog({
    action: "CHAOS_MODE_UPDATE",
    enabled: chaosConfig.enabled,
    latencyMin: chaosConfig.latencyMin,
    latencyMax: chaosConfig.latencyMax,
    errorRate: chaosConfig.errorRate,
    selectedAgents: chaosConfig.selectedAgents,
    user: "system_admin",
  });

  res.json({ ok: true, config: chaosConfig });
});

// Endpoints for Synthetic Macro Shock
chaosRouter.post("/macro-shock", async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Fallback shock
      const fallbackShock = {
        title: "LIQUIDITY PARADOX: STAGFLATION TRIGGER",
        description: "Federal Reserve unexpectedly hikes rates by 50bps while simultaneously announcing a quantitative easing liquidity facility due to sudden banking stress.",
        implications: "Severe capital flight from high-beta tech to safe-haven assets. Backtests suggest range-reversion strategies suffer short-term slippage.",
      };
      tradingEngine.state.activeMacroShock = fallbackShock;
      logSyntheticEvent(`SYNTHETIC MACRO SHOCK INJECTED (Fallback): ${fallbackShock.title}`);
      return res.json({ ok: true, shock: fallbackShock });
    }

    const ai = null;
    const prompt = `You are an elite financial scenario generator. Generate a highly complex, contradictory synthetic macro news cascade/economic event shock.
Examples:
- Federal Reserve unexpectedly hikes rates by 50bps while simultaneously announcing a quantitative easing liquidity facility due to sudden banking sector stress.
- Inflation numbers rise higher than expected (CPI +0.6% MoM), but unemployment climbs sharply to 4.8%, creating a stagflation paradox that freezes baseline algos.

Create a new scenario that has severe internal narrative contradiction.
Output MUST be strict JSON matching this structure:
{
  "title": "A short dramatic headline in uppercase, e.g. RATES SHOCK WITH QE BACKSTOP",
  "description": "2-3 sentences explaining the contradictory macro data cascade",
  "implications": "What range of outcomes this causes (e.g., tech selloff with safe-haven rotation)"
}`;

    const resShock = await generateContentWithRetry(ai, {
      model: "gemini-3.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json", temperature: 0.8 },
    });

    const parsed = cleanAndParseJSON(resShock.text);
    if (parsed && parsed.title) {
      tradingEngine.state.activeMacroShock = parsed;
      logSyntheticEvent(`SYNTHETIC MACRO SHOCK INJECTED: ${parsed.title}`);
      res.json({ ok: true, shock: parsed });
    } else {
      throw new Error("Failed to parse shock JSON from Gemini");
    }
  } catch (err: any) {
    console.error("Failed to generate macro shock:", err);
    const fallbackShock = {
      title: "SYSTEMIC CREDIT DRAWDOWNS ACTIVE",
      description: "Contradictory corporate earnings cascades coupled with bond yield inversions are flooding risk monitors.",
      implications: "Spike in baseline Vol Ratio. Momentum vectors show structural noise.",
    };
    tradingEngine.state.activeMacroShock = fallbackShock;
    logSyntheticEvent(`SYNTHETIC MACRO SHOCK INJECTED (Local Fallback): ${fallbackShock.title}`);
    res.json({ ok: true, shock: fallbackShock });
  }
});

chaosRouter.post("/macro-shock/clear", (req: Request, res: Response) => {
  if (tradingEngine.state.activeMacroShock) {
    logSyntheticEvent(`Synthetic Macro Shock CLEARED. Swarm restoring baseline narrative models.`);
    tradingEngine.state.activeMacroShock = null;
  }
  res.json({ ok: true });
});
