/**
 * Autonomous bot control/state routes: full state snapshot, memory-rule
 * add/delete, raw in-memory state passthrough, and genetic prompt evolution.
 * Extracted from server.ts structurally only — behavior is unchanged.
 *
 * Step 3 cleanup applied (no behavior change): the memory-rule delete catch
 * block previously returned an unrelated hardcoded "fallback news" object on
 * error (a copy-paste artifact); it now returns `{ error: message }` like
 * every other route's error handling in this file.
 */
import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import * as schema from "../db/schema";
import { tradingEngine } from "../engines/TradingEngine";
import { shadowPortfolioState } from "../state/shadowPortfolio";
import { tradingLimiter, aiLimiter } from "../core/RateLimiters";
import { resolveEnvTradingMode } from "../core/tradingModeEnv";

export const autobotRouter = Router();

// Gated off: this endpoint used to fabricate a Sharpe Ratio/DSR "fitness" score for every
// mutation (falling back to a hardcoded 1.84 baseline, then literally copying it forward
// unchanged every generation - its own comment admitted "Stagnant until real evaluation is
// implemented"), and would report a fabricated mutationType/explanation with the prompt left
// unchanged whenever no Gemini key was configured or the call failed. Separately,
// geneticPrompt.currentBestPrompt is never read by ChiefTraderAgent, AIRouter, or any other real
// agent - confirmed via grep, its only reader is this same route re-seeding the next mutation -
// so even a real fitness score would not be evaluating anything that affects actual trades.
// Refuses to run until both a real backtest-based fitness evaluation and a real prompt-injection
// path into an agent's actual AI calls exist (Batch 4+).
autobotRouter.post("/evolve", aiLimiter, async (req: Request, res: Response) => {
  res.status(501).json({
    error: "Prompt evolution is gated off: there is no real backtest to score a mutation's fitness against, " +
      "and the evolved prompt is not wired into any agent's actual AI calls. Re-enable once both exist."
  });
});

autobotRouter.get("/", async (req: Request, res: Response) => {
  const envMode = resolveEnvTradingMode();
  res.json({
    enabled: tradingEngine.state.enabled,
    autoBotEnabled: tradingEngine.state.enabled,
    scheduleWindow: tradingEngine.getScheduleWindowStatus(),
    tradingMode: tradingEngine.state.tradingMode,
    envTradingMode: envMode.mode,
    envTradingModeSource: envMode.source,
    paperTradingOnly: envMode.paperTradingOnly,
    liveBlockedByEnv: envMode.liveBlockedByEnv,
    budget: tradingEngine.state.budget,
    spent: tradingEngine.state.spent,
    remaining: tradingEngine.state.budget - tradingEngine.state.spent,
    strategy: tradingEngine.state.strategy,
    riskLevel: tradingEngine.state.riskLevel,
    maxTradeSize: tradingEngine.state.maxTradeSize,
    dailyLossLimit: tradingEngine.state.dailyLossLimit,
    currentDailyLoss: tradingEngine.state.currentDailyLoss,
    emergencyStopActive: tradingEngine.state.emergencyStopActive,
    // Real bug fix (2026-08-18): the frontend halt banner only ever read emergencyStopActive,
    // which is true ONLY for the literal EMERGENCY_STOP state (TradingEngine.ts:566) - never for
    // TRADING_PAUSED, even though RiskEngine's emergency_stop gate blocks both identically. This
    // field lets a cold page load correctly detect a reconciliation-triggered pause too.
    tradingState: tradingEngine.state.tradingState,
    takeProfitPct: tradingEngine.state.takeProfitPct,
    trailingStopPct: tradingEngine.state.trailingStopPct,
    minAiConfidence: tradingEngine.state.minAiConfidence,
    logs: tradingEngine.state.history,
    history: tradingEngine.state.history,
    learningJournal: tradingEngine.state.learningJournal,
    activeCycle: tradingEngine.state.activeCycle,
    memoryRules: await db.select().from(schema.memoryRules),
    adversarialDebateMode: tradingEngine.state.adversarialDebateMode,
    autoTradeScheduleEnabled: tradingEngine.state.autoTradeScheduleEnabled,
    autoTradeScheduleStartTime: tradingEngine.state.autoTradeScheduleStartTime,
    autoTradeScheduleEndTime: tradingEngine.state.autoTradeScheduleEndTime,
    autoTradeScheduleTimezone: tradingEngine.state.autoTradeScheduleTimezone,
    equityHistory: tradingEngine.state.equityHistory,
    bypassedTrades: tradingEngine.state.bypassedTrades,
    shadowPortfolio: shadowPortfolioState,
    engines: tradingEngine.state.engines,
    cycleCount: tradingEngine.state.cycleCount,
    activeMacroShock: tradingEngine.state.activeMacroShock,
    regimeState: tradingEngine.state.regimeState,
    geneticPrompt: tradingEngine.state.geneticPrompt,
    workers: (tradingEngine.state as any).workers || [],
    discoveredOpportunities: (tradingEngine.state as any).discoveredOpportunities || [],
    newsIntelligence: (tradingEngine.state as any).newsIntelligence || [],
    eventBus: (tradingEngine.state as any).eventBus || [],
    orchestratorWorkflows: (tradingEngine.state as any).orchestratorWorkflows || [],
  });
});

autobotRouter.post("/memory", async (req: Request, res: Response) => {
  const { action, rule, index } = req.body;
  try {
    if (action === "add" && rule) {
      tradingEngine.logHistory("info", `User injected Context Rule: ${rule}`);
      await db.insert(schema.memoryRules).values({ ruleText: rule, weight: 1.0, createdAt: Date.now() });
    } else if (action === "delete" && typeof index === "number") {
      tradingEngine.logHistory("info", `User deleted Context Rule.`);
      const allRules = await db.select().from(schema.memoryRules);
      if (allRules[index]) {
        await db.delete(schema.memoryRules).where(eq(schema.memoryRules.id, allRules[index].id));
      }
    }
    const updated = await db.select().from(schema.memoryRules);
    res.json({ ok: true, memoryRules: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

autobotRouter.get("/state", (req: Request, res: Response) => {
  res.json(tradingEngine.state);
});

autobotRouter.post("/toggle", tradingLimiter, async (req: Request, res: Response) => {
  const result = await tradingEngine.toggle(req.body);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json({ ok: true, state: tradingEngine.state });
});
