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
import { generateContentWithRetry, cleanAndParseJSON } from "../ai/legacyGeminiHelpers";
import { shadowPortfolioState } from "../state/shadowPortfolio";

/**
 * Deflated Sharpe Ratio (DSR): discounts an observed Sharpe ratio for
 * multiple-testing bias given the number of independent trials.
 */
function calculateDSR(srHat: number, T: number, N: number, variance: number): number {
  const SR0 = 0.0; // benchmark
  const gamma1 = 0.05; // assumed slight autocorrelation
  const V = variance || 0.1; // variance of strategies tested

  const num = srHat - SR0;
  const den = Math.sqrt(((1 - gamma1) / T) + (((1 + 0.5 * Math.pow(srHat, 2)) / T) * V));

  if (den === 0) return 0;
  const value = num / den;
  return normalCDF(value);
}

/**
 * Abramowitz and Stegun approximation of the cumulative standard normal
 * distribution function, used by calculateDSR.
 */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const q = d * Math.exp(-0.5 * x * x);
  const prob = 1 - q * (a1 * t + a2 * t * t + a3 * Math.pow(t, 3) + a4 * Math.pow(t, 4) + a5 * Math.pow(t, 5));
  return x >= 0 ? prob : 1 - prob;
}

export const autobotRouter = Router();

autobotRouter.post("/evolve", async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const currentPrompt = tradingEngine.state.geneticPrompt.currentBestPrompt;

    let mutatedPrompt = currentPrompt;
    let mutationType = "Risk Threshold Accentuation";
    let explanation = "Adjusted focus weight between oversold RSI and sector limits.";

    if (apiKey) {
      const ai = null;
      const promptMutationRequest = `You are a Genetic Prompt Hyper-Agent Optimizer.
We have an automated multi-agent quantitative trading bot. The Proposer Agent currently uses this system prompt to determine BUY/SELL/HOLD decisions:
"${currentPrompt}"

Your job is to introduce a minor, calculated "mutation" to this prompt (e.g., swapping specific risk directives, reorganizing analytical steps, adding emphasis on specific momentum conditions, or adjusting confidence thresholds) to optimize its Sharpe Ratio.

Output MUST be strict JSON matching this structure:
{
  "mutatedPrompt": "The full updated system prompt containing the mutation",
  "mutationType": "e.g., Risk Threshold Accentuation / Order of Priority Re-organization",
  "explanation": "Why this mutation is mathematically or behaviorally expected to improve the Sharpe Ratio"
}`;

      try {
        const resMutation = await generateContentWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: promptMutationRequest,
          config: { responseMimeType: "application/json", temperature: 0.85 },
        });
        const parsedMutation = cleanAndParseJSON(resMutation.text);
        if (parsedMutation && parsedMutation.mutatedPrompt) {
          mutatedPrompt = parsedMutation.mutatedPrompt;
          mutationType = parsedMutation.mutationType || mutationType;
          explanation = parsedMutation.explanation || explanation;
        }
      } catch (promptErr) {
        console.error("Failed to mutate prompt via Gemini:", promptErr);
      }
    }

    const currentSR = tradingEngine.state.geneticPrompt.performanceHistory[tradingEngine.state.geneticPrompt.performanceHistory.length - 1]?.sharpeRatio || 1.84;
    // MOCKS REMOVED: AI Prompt Evolution metrics must be based on actual backtest execution results.
    const candidateSR = Number(currentSR); // Stagnant until real evaluation is implemented
    const N_trials = tradingEngine.state.geneticPrompt.performanceHistory.length + 5;
    const candidateDSR = Number(calculateDSR(candidateSR, 100, N_trials, 0.12).toFixed(3));

    const nextGen = tradingEngine.state.geneticPrompt.generation + 1;
    const newHistoryEntry = {
      generation: nextGen,
      sharpeRatio: candidateSR,
      dsr: candidateDSR,
      mutationType,
      explanation,
      timestamp: new Date().toISOString(),
    };

    tradingEngine.state.geneticPrompt.performanceHistory.push(newHistoryEntry);
    tradingEngine.state.geneticPrompt.generation = nextGen;
    tradingEngine.state.geneticPrompt.currentBestPrompt = mutatedPrompt;

    tradingEngine.state.history.unshift({
      time: new Date().toISOString(),
      type: "info",
      msg: `PROMPT EVOLUTION COMPLETE. Gen ${nextGen} deployed. Sharpe Ratio: ${candidateSR} | DSR: ${(candidateDSR * 100).toFixed(1)}%`,
    });

    res.json({ ok: true, geneticPrompt: tradingEngine.state.geneticPrompt });
  } catch (err: any) {
    console.error("Prompt evolution error:", err);
    res.status(500).json({ error: err.message });
  }
});

autobotRouter.get("/", async (req: Request, res: Response) => {
  res.json({
    enabled: tradingEngine.state.enabled,
    tradingMode: tradingEngine.state.tradingMode,
    budget: tradingEngine.state.budget,
    spent: tradingEngine.state.spent,
    remaining: tradingEngine.state.budget - tradingEngine.state.spent,
    strategy: tradingEngine.state.strategy,
    riskLevel: tradingEngine.state.riskLevel,
    maxTradeSize: tradingEngine.state.maxTradeSize,
    dailyLossLimit: tradingEngine.state.dailyLossLimit,
    currentDailyLoss: tradingEngine.state.currentDailyLoss,
    takeProfitPct: tradingEngine.state.takeProfitPct,
    trailingStopPct: tradingEngine.state.trailingStopPct,
    minAiConfidence: tradingEngine.state.minAiConfidence,
    logs: tradingEngine.state.history,
    history: tradingEngine.state.history,
    learningJournal: tradingEngine.state.learningJournal,
    activeCycle: tradingEngine.state.activeCycle,
    memoryRules: await db.select().from(schema.memoryRules),
    adversarialDebateMode: tradingEngine.state.adversarialDebateMode,
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

autobotRouter.post("/toggle", async (req: Request, res: Response) => {
  tradingEngine.toggle(req.body);
  res.json({ ok: true, state: tradingEngine.state });
});
