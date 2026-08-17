/**
 * ==========================================================
 * Module:
 * server.ts
 *
 * Purpose:
 * Core backend simulation, multi-agent AI orchestration, and HTTP/WebSocket server for Argus.
 *
 * Responsibilities:
 * - Bootstraps the Express and Vite middleware.
 * - Initializes the SQLite Database (Drizzle ORM).
 * - Manages the global Autonomous Trading Engine (Bot Loop).
 * - Coordinates Multi-Agent AI workflows (Proposer, Risk, Reflection, Memory).
 * - Serves standard REST APIs for the React frontend.
 * - Manages WebSockets for real-time telemetry and streaming logs.
 *
 * Inputs:
 * - Incoming HTTP requests from frontend.
 * - WebSocket connections for live logs.
 * - External Mock Market Data streams (Alpaca/IEX).
 *
 * Outputs:
 * - JSON API Responses.
 * - WebSocket broadcast events (trade actions, logs, price updates).
 *
 * Emits:
 * - TRADE_EXECUTED
 * - TRADE_REJECTED
 * - BOT_STARTED / BOT_STOPPED
 * - REFLECTION_LOGGED
 *
 * Dependencies:
 * - AIRouter (Provider-agnostic AI Gateway)
 * - src/server/db (SQLite)
 *
 * Called By:
 * - Node.js entry point (npm run start / tsx server.ts)
 *
 * Never:
 * - Call LLM providers directly (Must use AIRouter).
 * - Mutate production portfolio balances outside of the risk-verified pipeline.
 *
 * ==========================================================
 */

/**
 * ==========================================================
 * ARCHITECTURE OVERVIEW: ARGUS BACKEND
 * ==========================================================
 * 
 * Market Data Stream
 *       ↓
 * Autonomous Engine (Bot Loop)
 *       ↓
 * AI Agents Pipeline
 *   1. Technical Agent (Generates Signal)
 *   2. News Agent (Generates Sentiment)
 *   3. Chief Trader (Aggregates Consensus)
 *   4. Risk Engine (ATR sizing, Veto checks)
 *       ↓
 * AIRouter (Multi-Provider Abstraction)
 *       ↓
 * LiteLLM / OpenRouter / Local
 *       ↓
 * SQLite Persistence (autoBotState)
 *       ↓
 * WebSocket Broadcast -> Frontend
 * ==========================================================
 */


import { kronosEngine } from "./src/server/engines/kronos/KronosEngine";
import { eq } from 'drizzle-orm';
import { db, sqliteDb } from './src/server/db/index';
import * as schema from './src/server/db/schema';

import { EncryptionService } from "./src/server/core/EncryptionService";
import { MarketDataManager } from "./src/marketdata/MarketDataManager";
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { AIRouter } from "./src/server/ai/AIRouter";
import { eventBus } from './src/server/core/EventBus';
import fs from "fs";
import express, { Request, Response } from "express";
import {  } from "./src/server/db/index.js";
import { logTrade, logAiDecision, logEventTrace } from "./src/server/core/Logger.js";
// import * as schema from "./src/server/db/schema.js";
import {  } from "drizzle-orm";
import { BrokerManager } from "./src/brokers/BrokerManager.js";
import { configRouter } from "./src/server/routes/configRoutes";
import { v2Router } from "./src/server/routes/v2System";
import { mountResearchRoutes } from "./src/server/routes/researchRoutes";
import { evaluateLiveReadiness } from "./src/server/core/liveReadinessEngine";
import { analyticsRouter } from "./src/server/routes/analyticsRoutes";
import { webhooksRouter, triggerWebhooks } from "./src/server/routes/webhooks";
import { generateContentWithRetry, cleanAndParseJSON } from "./src/server/ai/legacyGeminiHelpers";
import { auditLog, AUDIT_LOG_FILE } from "./src/server/core/auditLog";
import { chaosRouter } from "./src/server/routes/chaosRoutes";
import { systemRouter, handlePipelineAgentsGet, handlePipelineAgentsPost } from "./src/server/routes/systemRoutes";
import { newsRouter } from "./src/server/routes/newsRoutes";
import { autobotRouter } from "./src/server/routes/autobotRoutes";
import { shadowPortfolioState, saveShadowPortfolio } from "./src/server/state/shadowPortfolio";
import { integrationRouter } from "./src/server/routes/integrationRoutes";
import { tradingEngine } from "./src/server/engines/TradingEngine";
import { system } from "./src/server/core/SystemBootstrap";
import { marketDataWorker } from "./src/server/services/MarketDataWorker";
import { submitPipelineSells } from "./src/server/services/PipelineFlatten";
import { validateTargetAllocations, executeRebalance } from "./src/server/services/PortfolioRebalance";
import { brokerPortfolioError, withTimeout } from "./src/server/services/brokerPortfolioResponse";
import { loadInternalNewsForTicker } from "./src/server/services/internalNewsForTicker";
import { tradingSafety } from "./src/server/config/tradingSafety";
import { isAuthEnabled, validateCredentials as validateCredentialsPure, isSessionValid, enforceAuthConfigOrExit, allowUnauthenticatedRequest } from "./src/server/core/AuthConfig";
import { persistAllowlistedSecrets, secretsStatusFromEnvAndDb, SECRET_ALLOWLIST } from "./src/server/core/persistEncryptedSecrets";
import { loginLimiter, aiLimiter, tradingLimiter, backtestLimiter, wsUpgradeLimiter, webhookLimiter } from "./src/server/core/RateLimiters";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebSocket from "ws";



import { createServer as createViteServer } from "vite";

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.stack || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const stack = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error('[FATAL] unhandledRejection:', stack);
  process.exit(1);
});

const AUTOBOT_SYMBOLS = ["TSLA", "NVDA", "AAPL", "MSTR", "PLTR", "CRWD", "AMD", "SNOW", "META", "GOOG", "COIN"];


let riskVetos: any[] = [];
let scheduledTasks: any[] = (globalThis as any).__argusScheduledTasks ??= [];
let recentTrades: any[] = [];
let historicalPrecedents: any[] = [];



let liveNews: any = {};
let alpacaNewsWs: any = null;

function initializeAlpacaNewsWebSocket() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return;

  const newsWssUrl = "wss://stream.data.alpaca.markets/v1beta1/news";
  alpacaNewsWs = new WebSocket(newsWssUrl);
  
  alpacaNewsWs.addEventListener("open", () => {
    console.log('[Alpaca News WS] Connected to news stream.');
    alpacaNewsWs.send(JSON.stringify({
      action: 'auth',
      key: process.env.ALPACA_API_KEY,
      secret: process.env.ALPACA_SECRET_KEY
    }));
  });
  
  alpacaNewsWs.addEventListener("message", (event) => {
    const messages = JSON.parse(event.data.toString());
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('[Alpaca News WS] Authenticated successfully. Subscribing to news...');
        alpacaNewsWs.send(JSON.stringify({
          action: 'subscribe',
          news: ["*"] // Subscribe to all news
        }));
      } else if (msg.T === 'n') {
        // Store latest news by symbol
        for (const symbol of msg.symbols) {
           if (!liveNews[symbol]) liveNews[symbol] = [];
           liveNews[symbol].unshift(msg);
           // Keep only last 5
           if (liveNews[symbol].length > 5) {
             liveNews[symbol].pop();
           }
        }
      }
    }
  });
  
  alpacaNewsWs.addEventListener("close", () => {
    console.log('[Alpaca News WS] Connection closed.');
  });
  
  alpacaNewsWs.addEventListener("error", (err) => {
    console.error('[Alpaca News WS] Error:', err.message);
  });
}

dotenv.config();
if (process.env.ALPACA_SECRET_KEY && !process.env.ALPACA_API_SECRET) {
  process.env.ALPACA_API_SECRET = process.env.ALPACA_SECRET_KEY;
}

/**
 * Prompts two separate sub-agents (The Bull and The Bear) to analyze the current trade proposal.
 * Generates competing investment/risk theses for the target symbol.
 */
async function generateCompetingTheses(
  ai: any,
  symbol: string,
  headline: string,
  marketContext: string = "Normal market conditions.",
  pastContext: string = "",
  techContext: string = ""
) {
  const bullPrompt = `You are a highly optimistic, quantitative Bullish Analyst Agent (Agent 1a). Given the following market telemetry for ${symbol}, formulate a strong BUY/LONG investment brief. Focus on bullish support levels, positive momentum indicators, macro sectors, and upward breakout catalysts.
Target Asset: ${symbol}
Headline: "${headline}"
Market Context: ${marketContext}
${pastContext}
${techContext}

Output MUST be valid JSON matching this exact structure:
{
  "thesis": "1-sentence highly bullish investment brief emphasizing positive indicators",
  "target_price": "Simulated short-term target price based on current spot"
}`;

  const bearPrompt = `You are a highly defensive, skeptical Bearish Analyst Agent (Agent 1b). Given the following market telemetry for ${symbol}, formulate a strong SELL/SHORT investment brief. Focus on overhead resistance levels, RSI overbought signs, momentum exhaustion, and negative catalysts.
Target Asset: ${symbol}
Headline: "${headline}"
Market Context: ${marketContext}
${pastContext}
${techContext}

Output MUST be valid JSON matching this exact structure:
{
  "thesis": "1-sentence highly bearish defensive risk brief emphasizing overhead hurdles and weaknesses",
  "stop_trigger_price": "Simulated breakdown trigger price below current spot"
}`;

  let bullOutput = { thesis: "Upward momentum looks favorable on solid volume support.", target_price: "155.00" };
  let bearOutput = { thesis: "RSI is near local highs, suggesting potential overhead resistance exhaustion.", stop_trigger_price: "142.00" };

  try {
    const [bullRes, bearRes] = await Promise.all([
      generateContentWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: bullPrompt,
        config: { responseMimeType: "application/json", temperature: 0.8 }
      }),
      generateContentWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: bearPrompt,
        config: { responseMimeType: "application/json", temperature: 0.8 }
      })
    ]);

    bullOutput = cleanAndParseJSON(bullRes.text) || bullOutput;
    bearOutput = cleanAndParseJSON(bearRes.text) || bearOutput;
  } catch (err) {
    console.error("[generateCompetingTheses] Parallel generation error, falling back to static defaults:", err);
  }

  return { bull: bullOutput, bear: bearOutput };
}

/* === BACKEND CONFIGURATION & UTILITIES === */
// Multi-LLM provider abstraction layer
async function callLLM(provider: string, prompt: string, modelConfig?: any) {
  // Uses exponential backoff retry and TTL LRU cache logic

  // For Gemini:
  if (provider === "Gemini" && process.env.GEMINI_API_KEY) {
     const ai = null; // Removed Gemini dependency
     const res = await generateContentWithRetry(ai, {
        model: modelConfig?.model || "gemini-3.5-flash",
        contents: prompt
     });
     return res.text;
  }
  // Simulated fallback for OpenAI / Anthropic / Mistral
  
  throw new Error(`Provider ${provider} is not configured or available.`);
}

/**
 * Executes a query across multiple LLM providers to reach a consensus.
 * This provides a multi-agent verification layer.
 * @param prompt - The system prompt to query.
 */
async function callLLMConsensus(prompt: string) {
  try {
     return await AIRouter.getInstance().routeConsensus("ConsensusDebate", prompt, crypto.randomUUID());
  } catch (e: any) {
     return {
        consensus_verdict: "HOLD",
        latency_ms: 0,
        results: [{ provider: "mock", status: "error", error: e.message, latencyMs: 0 }]
     };
  }
}


type LLMProviderId = "gemini" | "openai" | "anthropic" | "mistral";

const LLM_PROVIDER_REGISTRY: Record<LLMProviderId, { label: string; envKey: string; defaultModel: string }> = {
  gemini:    { label: "Google Gemini",   envKey: "GEMINI_API_KEY",    defaultModel: "gemini-3.5-flash" },
  openai:    { label: "OpenAI",          envKey: "OPENAI_API_KEY",    defaultModel: "gpt-4o-mini" },
  anthropic: { label: "Anthropic Claude", envKey: "ANTHROPIC_API_KEY", defaultModel: "claude-3-5-haiku-20241022" },
  mistral:   { label: "Mistral",         envKey: "MISTRAL_API_KEY",   defaultModel: "mistral-small-latest" },
};

let activeLLMProvider: string = (process.env.ACTIVE_LLM || "gemini").toLowerCase();

async function startServer() {
  await AIRouter.getInstance().initialize();
  await tradingEngine.initialize();
  
  // -- SQLite Initialization --
        
  // autoBotState initialization removed


  // Ensure default settings exist
  let settings = await db.select().from(schema.settings).limit(1);
  if (settings.length === 0) {
    await db.insert(schema.settings).values({



      tradingMode: 'PAPER',
      riskLevel: 'Medium',
      budget: 50000,
      strategy: 'Momentum Focus',
      maxTradeSize: 3000,
      dailyLossLimit: 5000,
      takeProfitPct: 15,
      trailingStopPct: 5,
      minAiConfidence: 75,
      adversarialDebateMode: true
    });
    settings = await db.select().from(schema.settings).limit(1);
  }
  
  // Initialize broker manager so configured broker selection is active at runtime
  await BrokerManager.getInstance().initialize();

  try {
    marketDataWorker.start();
    console.log('[MarketDataWorker] Started at boot (independent of Autobot). RiskEngine data_freshness still requires a fresh tick.');
  } catch (e: any) {
    console.warn(`[MarketDataWorker] Boot start failed: ${e.message}`);
  }

  try {
    const { autoTradeScheduler } = await import('./src/server/services/AutoTradeScheduler');
    autoTradeScheduler.start();
    console.log('[AutoTradeScheduler] Started at boot (independent of Autobot state; no-op unless settings.autoTradeScheduleEnabled is true).');
  } catch (e: any) {
    console.warn(`[AutoTradeScheduler] Boot start failed: ${e.message}`);
  }

  try {
    const { modelRuntimeManager } = await import("./src/server/ai/ModelRuntimeManager");
    const models = await modelRuntimeManager.startAndProbe();
    for (const m of models) {
      const line = m.health === "READY"
        ? `[ModelRuntime] ${m.modelId.padEnd(16)} READY  ${m.detail || ""}`
        : `[ModelRuntime] ${m.modelId.padEnd(16)} ${m.health}  Reason: ${m.detail || "unknown"}  Action: ${m.action || "none"}`;
      if (m.health === "READY" || m.health === "DISABLED") console.log(line);
      else console.warn(line);
    }
  } catch (e: any) {
    console.warn(`[ModelRuntime] Probe failed (Argus remains usable): ${e.message}`);
  }
  
  // Update in-memory autobot state to match DB
  Object.assign(tradingEngine.state, {
    tradingMode: settings[0].tradingMode,
    riskLevel: settings[0].riskLevel,
    budget: settings[0].budget,
    strategy: settings[0].strategy,
    maxTradeSize: settings[0].maxTradeSize,
    dailyLossLimit: settings[0].dailyLossLimit,
    takeProfitPct: settings[0].takeProfitPct,
    trailingStopPct: settings[0].trailingStopPct,
    minAiConfidence: settings[0].minAiConfidence,
    adversarialDebateMode: settings[0].adversarialDebateMode,
  });

  await ensureSessionsTableExists();
  await ensureDailyTradingSummaryTableExists();
  
  console.log('Argus DB initialized and state loaded.');

  
// AUTH & SECRETS
//
// Real authentication bypass fixed here (FINAL_ANALYSIS.md Section 15.12): the old
// validateCredentials() did `username === AUTH_USERNAME && password === AUTH_PASSWORD` with no
// check that AUTH_PASSWORD was actually set, so an empty-body /login succeeded (undefined ===
// undefined on both sides) and minted a real session cookie. The pure logic now lives in
// AuthConfig.ts (unit-tested there); this just wires it to the real process.env and DB.
const AUTH_ENV = {
  AUTH_USERNAME: process.env.AUTH_USERNAME,
  AUTH_PASSWORD: process.env.AUTH_PASSWORD,
  AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET,
  NODE_ENV: process.env.NODE_ENV,
};
const AUTH_ENABLED = isAuthEnabled(AUTH_ENV);
enforceAuthConfigOrExit(AUTH_ENV);

const SESSION_TTL_MS = (Number(process.env.AUTH_SESSION_TTL_DAYS) || 3650) * 24 * 60 * 60 * 1000; // Default 10 years
const SESSION_COOKIE = "argus_session";

function validateCredentials(username: string, password: string): boolean {
  return validateCredentialsPure(AUTH_ENV, username, password);
}

function getSessionToken(req: Request): string | null {
  const cookies = req.headers.cookie || "";
  const match = cookies.match(new RegExp(SESSION_COOKIE + "=([^;]+)"));
  return match ? match[1] : null;
}

async function ensureSessionsTableExists(): Promise<void> {
  try {
    sqliteDb.exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  } catch (e) {
    console.warn("Could not ensure sessions table exists:", e);
  }
}

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    sameSite: 'lax',
    path: '/',
  });
}

async function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

async function createSession(res: Response, username: string) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db.insert(schema.sessions).values({
    sessionToken: token,
    username,
    expiresAt,
    lastSeen: now,
    createdAt: now,
  }).run();

  setSessionCookie(res, token);
}

async function maybeRefreshSession(req: Request, res: Response): Promise<void> {
  const token = getSessionToken(req);
  if (!token) return;

  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionToken, token)).limit(1);
  if (rows.length === 0) return;

  const sessionRow = rows[0];
  const now = Date.now();

  if (sessionRow.expiresAt <= now) {
    await db.delete(schema.sessions).where(eq(schema.sessions.sessionToken, token)).run();
    await clearSessionCookie(res);
    return;
  }

  const shouldRefresh = sessionRow.expiresAt - now < SESSION_TTL_MS / 2;
  if (shouldRefresh) {
    const newExpiresAt = now + SESSION_TTL_MS;
    await db.update(schema.sessions).set({ expiresAt: newExpiresAt, lastSeen: now }).where(eq(schema.sessions.sessionToken, token)).run();
    setSessionCookie(res, token);
  } else {
    await db.update(schema.sessions).set({ lastSeen: now }).where(eq(schema.sessions.sessionToken, token)).run();
  }
}

async function ensureDailyTradingSummaryTableExists(): Promise<void> {
  try {
    sqliteDb.exec(`CREATE TABLE IF NOT EXISTS daily_trading_summary (
      date TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      total_volume REAL DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      allocated_amount REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
  } catch (e) {
    console.warn("Could not create daily trading summary table:", e);
  }
}

async function updateDailyTradingSummary(activity: {
  status: string;
  quantity: number;
  price: number;
  profitLoss?: number | null;
  timestamp: string;
}, portfolioState?: any) {
  const date = activity.timestamp.slice(0, 10);
  const totalVolume = Math.abs(activity.quantity) * activity.price;
  const realizedPnl = Number(activity.profitLoss || 0);
  const allocatedAmount = portfolioState?.positions?.reduce(
    (sum: number, p: any) => sum + Number(p.marketValue || 0),
    0,
  ) || 0;
  const unrealizedPnl = portfolioState?.positions?.reduce(
    (sum: number, p: any) => sum + Number(p.unrealizedPnl || 0),
    0,
  ) || 0;

  const existing = await db.select().from(schema.dailyTradingSummary).where(eq(schema.dailyTradingSummary.date, date)).limit(1);
  if (existing.length > 0) {
    const row = existing[0];
    await db.update(schema.dailyTradingSummary).set({
      totalTrades: row.totalTrades + 1,
      totalVolume: row.totalVolume + totalVolume,
      realizedPnl: row.realizedPnl + realizedPnl,
      unrealizedPnl: unrealizedPnl,
      allocatedAmount: allocatedAmount,
      updatedAt: Date.now(),
    }).where(eq(schema.dailyTradingSummary.date, date)).run();
  } else {
    await db.insert(schema.dailyTradingSummary).values({
      date,
      totalTrades: 1,
      totalVolume: totalVolume,
      realizedPnl: realizedPnl,
      unrealizedPnl: unrealizedPnl,
      allocatedAmount: allocatedAmount,
      updatedAt: Date.now(),
    }).run();
  }
}

async function persistTradeActivity(activity: {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  status: string;
  timestamp: string;
  reasoning?: string;
  traceId?: string | null;
  profitLoss?: number | null;
  newsUsed?: boolean;
  newsSentiment?: number | null;
  newsConfidence?: number | null;
  newsSources?: string;
  newsReasoning?: string;
}, portfolioState?: any) {
  try {
    await db.insert(schema.trades).values(activity).run();
    if (portfolioState) {
      await updateDailyTradingSummary(activity, portfolioState);
    }
  } catch (e) {
    console.warn("Failed to persist trade activity:", e);
  }
}

async function isAuthed(req: Request): Promise<boolean> {
  if (!AUTH_ENABLED) {
    return allowUnauthenticatedRequest({
      method: req.method,
      path: req.path,
      ip: req.ip || req.socket?.remoteAddress,
      devTokenHeader: req.headers['x-argus-dev-token'],
    });
  }

  const token = getSessionToken(req);
  if (!token) return false;

  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionToken, token)).limit(1);
  return isSessionValid(rows[0] ?? null);
}

// Resolves the authenticated username for audit attribution (e.g. kill-switch events). Returns
// 'anonymous' rather than throwing when auth is disabled or no session is present - callers that
// require real attribution (none currently do) should check AUTH_ENABLED themselves.
async function getCurrentActor(req: Request): Promise<string> {
  if (!AUTH_ENABLED) return 'anonymous (no-auth mode)';
  const token = getSessionToken(req);
  if (!token) return 'anonymous';
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionToken, token)).limit(1);
  return isSessionValid(rows[0] ?? null) ? rows[0].username : 'anonymous';
}

const SECRETS_FILE_IGNORED = path.join(process.cwd(), "data", "secrets.json");
if (fs.existsSync(SECRETS_FILE_IGNORED)) {
  const msg = '[SECURITY] data/secrets.json must not exist. Keys must live in .env or encrypted SQLite (broker_connections / ai_providers). Plaintext file is not read or written.';
  if (process.env.ARGUS_ALLOW_PLAINTEXT_SECRETS_FILE === 'true') {
    console.warn(`${msg} Boot continues only because ARGUS_ALLOW_PLAINTEXT_SECRETS_FILE=true.`);
  } else {
    throw new Error(`${msg} Move keys, delete the file, then restart. (Override only with ARGUS_ALLOW_PLAINTEXT_SECRETS_FILE=true.)`);
  }
}

  const app = express();
  initializeAlpacaNewsWebSocket();

  app.use(async (req: Request & { actor?: string }, res, next) => {
    if (req.path.startsWith('/api/v1/auth')) return next();
    if (await isAuthed(req)) {
      await maybeRefreshSession(req, res);
      req.actor = await getCurrentActor(req);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.use(express.json());

  // Unauthenticated by design (registered before the /api/* auth gate matters, and outside
  // /api/ entirely) - container orchestrators and load balancers hit these without a session.
  // Liveness: the process can respond at all, no dependency checks.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Readiness: the process can actually serve real requests - checks the one hard dependency
  // every route ultimately needs, the SQLite connection.
  app.get('/ready', (req, res) => {
    try {
      sqliteDb.prepare('SELECT 1').get();
      res.json({ status: 'ready' });
    } catch (e: any) {
      res.status(503).json({ status: 'not ready', error: e.message });
    }
  });

  async function getOnboardingComplete(): Promise<boolean> {
    const rows = await db.select({ onboardingComplete: schema.settings.onboardingComplete }).from(schema.settings).limit(1);
    return rows[0]?.onboardingComplete === true;
  }

  const authRouter = express.Router();
  authRouter.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!validateCredentials(username, password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await createSession(res, username);
    res.json({ ok: true, onboardingComplete: await getOnboardingComplete() });
  });

  authRouter.get('/status', async (req, res) => {
    const authed = await isAuthed(req);
    res.json({ authenticated: authed, onboardingComplete: authed ? await getOnboardingComplete() : false });
  });

  authRouter.post('/logout', async (req, res) => {
    const token = getSessionToken(req);
    if (token) {
      await db.delete(schema.sessions).where(eq(schema.sessions.sessionToken, token)).run();
    }
    await clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.use('/api/v1/auth', authRouter);
  app.use("/api/v1/config", configRouter);
  app.use("/api/v1", configRouter);
  app.use("/api/v2", v2Router);
  // Belt-and-suspenders: ensure live-readiness is reachable even if a stale v2Router bundle
  // somehow omitted the handler (banner polls this every 30s).
  app.get('/api/v2/live-readiness', (_req, res) => {
    try {
      const report = evaluateLiveReadiness();
      res.json({ ok: true, ...report, live: report.result === 'LIVE_READY' ? 'GO' : 'NO-GO' });
    } catch (e: any) {
      res.status(200).json({
        ok: false,
        result: 'LIVE_NO_GO',
        tradingEdgeScore: 8,
        organicPaper: 'NOT_ESTABLISHED',
        canadianLive: 'NOT_AVAILABLE',
        failedMandatory: ['LIVE_READINESS_ENGINE_ERROR'],
        canPlaceOrdersViaResearch: false,
        live: 'NO-GO',
        error: e?.message || String(e),
      });
    }
  });
  // Phase 24 MODE B failsafe — second mount of the research route table. If the primary
  // v2Router ever boots without these handlers (stale tsx graph / partial import), Express
  // falls through unmatched routes to this router instead of the /api/* 404 catch-all.
  {
    const researchFailsafe = express.Router();
    mountResearchRoutes(researchFailsafe);
    app.use('/api/v2', researchFailsafe);
    const replayPaths = ((researchFailsafe as any).stack || [])
      .map((l: any) => l?.route?.path)
      .filter((p: unknown): p is string => typeof p === 'string' && p.includes('replay'));
    console.log(`[boot] research replay routes mounted (${replayPaths.length}): ${replayPaths.join(', ')}`);
    if (!replayPaths.includes('/research/replay/create')) {
      console.error('[boot] FATAL-ISH: /research/replay/create missing after mountResearchRoutes — Historical Replay Lab will 404');
    }
  }
  app.use("/api/v2/analytics", analyticsRouter);
  app.get('/api/v1/scheduler', (req, res) => {
    res.json({ tasks: scheduledTasks });
  });

  app.post('/api/v1/scheduler', (req, res) => {
    const task = {
      id: `task_${Math.random().toString(16).slice(2)}`,
      frequency: req.body.frequency || 'Daily',
      targetWeights: req.body.targetWeights || {},
      createdAt: new Date().toISOString(),
    };
    scheduledTasks.push(task);
    res.json({ task });
  });

  app.delete('/api/v1/scheduler/:id', (req, res) => {
    const id = req.params.id;
    scheduledTasks = scheduledTasks.filter((task) => task.id !== id);
    res.json({ ok: true });
  });

  app.get('/api/v1/risk', (req, res) => {
    res.json(riskVetos);
  });

  app.post('/api/v1/risk/:id/review', tradingLimiter, (req, res) => {
    const id = req.params.id;
    const existing = riskVetos.find((v) => v.id === id);
    if (!existing) {
      return res.status(404).json({ error: 'Risk veto not found' });
    }
    const updated = {
      ...existing,
      review: req.body.review || existing.review || 'Reviewed by operator',
      reviewedAt: new Date().toISOString(),
      status: req.body.status || existing.status || 'REVIEWED',
    };
    riskVetos = riskVetos.map((v) => (v.id === id ? updated : v));
    res.json(updated);
  });

  // Resolve static build folders
  const dirName = process.cwd();
  const isProd = process.env.NODE_ENV === "production";

  // Initialize modern Google GenAI Client
  let ai: any | null = null;
  if (process.env.GEMINI_API_KEY) {
    try {
      ai = null;
      console.log("Successfully initialized server-side Gemini AI client.");
    } catch (error) {
      console.error(
        "Failed to initialize server-side Gemini AI client:",
        error,
      );
    }
  }

  // Non-blocking check for the local hybrid AI stack (see docs/LOCAL_AI_SETUP.md, `npm run
  // setup:ai`). Never fails startup - the app is fully functional on cloud providers alone.
  (async () => {
    const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
    const EXPECTED_OLLAMA_MODELS = ["llama3.2:latest", "llama3.2:1b", "0xroyce/plutus:latest", "fingpt:latest"];
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const present = new Set((data.models || []).map((m: any) => m.name));
      const missing = EXPECTED_OLLAMA_MODELS.filter((m) => !present.has(m));
      if (missing.length > 0) {
        console.warn(`[LocalAI] Ollama is running at ${OLLAMA_HOST} but missing model(s): ${missing.join(", ")}. Run 'npm run setup:ai'.`);
      } else {
        console.log(`[LocalAI] Ollama reachable at ${OLLAMA_HOST} with all ${EXPECTED_OLLAMA_MODELS.length} expected local models.`);
      }
    } catch (e: any) {
      console.warn(`[LocalAI] Ollama not reachable at ${OLLAMA_HOST} (${e.message}). Local models are unavailable - agents will fall back to cloud providers only. Run 'npm run setup:ai' after installing Ollama.`);
    }
  })();

  // Simulated trading platform state in server
  interface TradingPosition {
    symbol: string;
    quantity: number;
    entryPrice: number;
    currentPrice: number;
    totalCost: number;
    marketValue: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    sector: string;
    openedAt: string;
  }

  interface HistoricalPrecedent {
    id: string;
    title: string;
    category: string;
    description: string;
    marketImpact: string;
    score?: number;
    confidence?: number;
  }

  const defaultPositions: TradingPosition[] = [];

const PORTFOLIO_FILE = path.join(process.cwd(), "data", "portfolio.json");

/**
 * Calculates the 14-period Average True Range (ATR) using High, Low, and Close arrays.
 * Uses Wilder's smoothed moving average methodology.
 */
function calculateATR(highs: number[], lows: number[], closes: number[]): number {
  const period = 14;
  if (highs.length < period + 1) {
    return 1.5; // fallback
  }
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  // Calculate the initial ATR (simple average of the first 'period' True Ranges)
  let atr = trs.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  
  // Calculate Wilder's smoothing for subsequent periods
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * Calculates Average Directional Index (ADX) and rolling volatility ratio to classify market regime.
 * Returns ADX, +DI, -DI, Volatility Ratio, and classified market regime.
 */
function calculateADX(highs: number[], lows: number[], closes: number[]): { adx: number, plusDI: number, minusDI: number, volatilityRatio: number, regime: "RANGE" | "TRENDING" | "TRANSITIONAL", details: string } {
  const period = 14;
  if (highs.length < period + 1) {
    return { adx: 25, plusDI: 20, minusDI: 20, volatilityRatio: 1.0, regime: "TRANSITIONAL", details: "Insufficient periods" };
  }

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // Initial sum
  let smoothedTR = trs.slice(0, period).reduce((sum, val) => sum + val, 0);
  let smoothedPlusDM = plusDMs.slice(0, period).reduce((sum, val) => sum + val, 0);
  let smoothedMinusDM = minusDMs.slice(0, period).reduce((sum, val) => sum + val, 0);

  const dxValues: number[] = [];
  let plusDI = (smoothedTR > 0) ? (smoothedPlusDM / smoothedTR) * 100 : 0;
  let minusDI = (smoothedTR > 0) ? (smoothedMinusDM / smoothedTR) * 100 : 0;
  let dx = (plusDI + minusDI > 0) ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0;
  dxValues.push(dx);

  for (let i = period; i < trs.length; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + trs[i];
    smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDMs[i];
    smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDMs[i];

    plusDI = (smoothedTR > 0) ? (smoothedPlusDM / smoothedTR) * 100 : 0;
    minusDI = (smoothedTR > 0) ? (smoothedMinusDM / smoothedTR) * 100 : 0;
    dx = (plusDI + minusDI > 0) ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0;
    dxValues.push(dx);
  }

  let adx = dxValues.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  // Volatility ratio calculation (rolling std dev)
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((sum, val) => sum + val, 0) / returns.length;
  const variance = returns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (returns.length - 1 || 1);
  const rollingVolatility = Math.sqrt(variance);
  const volatilityRatio = rollingVolatility / 0.015; // normalized ratio

  let regime: "RANGE" | "TRENDING" | "TRANSITIONAL" = "TRANSITIONAL";
  if (adx < 20) {
    regime = "RANGE";
  } else if (adx > 30) {
    regime = "TRENDING";
  }

  const details = `ADX: ${adx.toFixed(2)} | +DI: ${plusDI.toFixed(2)} | -DI: ${minusDI.toFixed(2)} | Vol Ratio: ${volatilityRatio.toFixed(2)}`;

  return { adx, plusDI, minusDI, volatilityRatio, regime, details };
}

/**
 * 1. Choppiness Index (CHOP)
 */
function calculateCHOP(highs: number[], lows: number[], closes: number[], n: number = 14): number {
  if (highs.length < n) return 50;
  const recentHighs = highs.slice(-n);
  const recentLows = lows.slice(-n);
  const recentCloses = closes.slice(-(n + 1));
  
  let sumATR = 0;
  for (let i = 1; i <= n; i++) {
    const high = recentHighs[i - 1];
    const low = recentLows[i - 1];
    const prevClose = recentCloses[i - 1]; // using n+1 length array to access prev close
    if (prevClose === undefined) {
       sumATR += (high - low);
       continue;
    }
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sumATR += tr;
  }
  
  const maxHigh = Math.max(...recentHighs);
  const minLow = Math.min(...recentLows);
  const range = maxHigh - minLow;
  
  if (range === 0) return 50;
  
  return 100 * (Math.log10(sumATR / range) / Math.log10(n));
}

/**
 * 2. Statistical Z-Score
 */
function calculateZScore(prices: number[], n: number = 14): number {
  if (prices.length < n) return 0;
  const slice = prices.slice(-n);
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;
  const currentPrice = slice[slice.length - 1];
  return (currentPrice - mean) / stdDev;
}

/**
 * 3. Amihud Illiquidity Measure
 */
function calculateAmihud(closes: number[], volumes: number[], n: number = 14): number {
  if (closes.length < n + 1 || volumes.length < n) return 0;
  let sumIlliq = 0;
  
  const recentCloses = closes.slice(-(n + 1));
  const recentVols = volumes.slice(-n);
  
  for (let i = 1; i <= n; i++) {
    const ret = (recentCloses[i] - recentCloses[i - 1]) / recentCloses[i - 1];
    const absRet = Math.abs(ret);
    const dollarVol = recentCloses[i] * recentVols[i - 1];
    if (dollarVol > 0) {
      sumIlliq += (absRet / dollarVol);
    }
  }
  
  return sumIlliq / n;
}

/**
 * 4. On-Balance Volume (OBV) Divergence
 */
function checkOBVDivergence(closes: number[], volumes: number[], n: number = 14): boolean {
  if (closes.length < n + 1 || volumes.length < n) return false;
  
  let obv = 0;
  const obvSeries = [];
  const recentCloses = closes.slice(-(n + 1));
  const recentVols = volumes.slice(-n);
  
  for (let i = 1; i <= n; i++) {
    if (recentCloses[i] > recentCloses[i - 1]) {
      obv += recentVols[i - 1];
    } else if (recentCloses[i] < recentCloses[i - 1]) {
      obv -= recentVols[i - 1];
    }
    obvSeries.push(obv);
  }
  
  // Calculate slopes
  const priceSlice = recentCloses.slice(1);
  const priceSlope = priceSlice[priceSlice.length - 1] - priceSlice[0];
  const obvSlope = obvSeries[obvSeries.length - 1] - obvSeries[0];
  
  // If price is up but OBV is down (Bearish Divergence)
  if (priceSlope > 0 && obvSlope < 0) return true;
  
  return false;
}

/**
 * 5. Kelly Criterion
 */
function calculateKelly(winRate: number, rewardRiskRatio: number): number {
  if (rewardRiskRatio <= 0) return 0;
  const p = winRate;
  const q = 1 - p;
  const b = rewardRiskRatio;
  return p - (q / b);
}

/**
 * Generates simulated historical High, Low, and Close prices and Volumes for a symbol.
 */
function generateHistoricalPrices(symbol: string, periods: number = 15) {
  const basePrices: Record<string, number> = {
    TSLA: 220,
    NVDA: 120,
    AAPL: 180,
    MSTR: 1400,
    PLTR: 35,
    CRWD: 260,
    AMD: 150,
    SNOW: 160,
    META: 480,
    GOOG: 170,
    COIN: 220
  };
  const base = basePrices[symbol] || 150;
  
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  const volumes: number[] = [];
  
  let currentPrice = base;
  for (let i = 0; i < periods; i++) {
    const change = (Math.random() - 0.48) * (base * 0.03);
    const close = Math.max(1, currentPrice + change);
    const high = close + (Math.random() * (base * 0.015));
    const low = Math.max(0.5, close - (Math.random() * (base * 0.015)));
    const volume = Math.floor(Math.random() * 5000000) + 1000000;
    
    highs.push(high);
    lows.push(low);
    closes.push(close);
    volumes.push(volume);
    
    currentPrice = close;
  }
  
  return { highs, lows, closes, volumes, currentPrice };
}

/**
 * Loads the portfolio state from the simulated local database or memory.
 * Returns the active portfolio configuration.
 */
function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      const data = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf-8"));
      if (!data.positions) data.positions = [];
      return data;
    }
  } catch (e) {
    console.warn("Could not load portfolio from disk, using defaults.");
  }
  // Starts empty (no fabricated positions) - schema.portfolio has no real writer in the live
  // pipeline (OrderManagement.ts writes trades, not this table), so any seeded row here would sit
  // untouched and get served by /api/v1/portfolio as if it were a real broker-confirmed position.
  const defaultP = {
    cash: 100000.0,
    initialCash: 100000.0,
    peakValuation: 100000.0,
    positions: [],
  };
  savePortfolio(defaultP);
  return defaultP;
}

/**
 * Saves the active portfolio state to persistent storage.
 * @param state - The updated portfolio state object.
 */
function savePortfolio(state: any) {
  try {
    // Delete all current and insert to keep it simple, or iterate and upsert
    db.delete(schema.portfolio).run();
    if (state.positions && state.positions.length > 0) {
      const values = state.positions.map(p => ({
        symbol: p.symbol,
        quantity: Number(p.quantity) || 0,
        averagePrice: Number(p.totalCost) / Number(p.quantity) || 0,
        currentPrice: Number(p.currentPrice) || 0,
        lastUpdated: new Date().toISOString(),
        unrealizedPnL: Number(p.unrealizedPnl) || 0,
        brokerSource: 'AutoBot'
      }));
      db.insert(schema.portfolio).values(values).run();
    }
  } catch (e) {
    console.error("Failed to save portfolio to DB:", e);
  }
}

let portfolioState = loadPortfolio();

  app.use("/api/v1/webhooks", webhookLimiter, webhooksRouter);

  app.get("/api/v1/portfolio", async (req: Request, res: Response) => {
    try {
      const broker = BrokerManager.getInstance().getActiveBroker();
      if (!broker) {
        return res.status(503).json({
          available: false,
          error: "Broker unavailable: no active broker",
          reason: "No active broker is initialized.",
        });
      }
      // No fabricated fallback if the broker call fails - a real error surfaces as a real error
      // instead of a fake $10,000 placeholder that looks like a real (if small) account.
      const portfolio = await withTimeout(
        broker.portfolio(),
        tradingSafety.alpacaRequestTimeoutMs,
        "broker.portfolio()",
      );

      // Positions come from the active broker directly, not from schema.portfolio - that table
      // has no writer in the live pipeline (OrderManagement.ts writes trades, not portfolio rows)
      // and was previously left holding stale/fabricated seed data that this route served instead
      // of the broker's real position list. See Phase 0 of the production-readiness audit.

      // Keep track of peak valuation for drawdown
      if (portfolio.equity > portfolioState.peakValuation) {
         portfolioState.peakValuation = portfolio.equity;
      }
      const drawdown = (portfolioState.peakValuation - portfolio.equity) / portfolioState.peakValuation;

      res.json({
         available: true,
         cash: portfolio.cash,
         buying_power: portfolio.buyingPower,
         equity: portfolio.equity,
         positions: portfolio.positions,
         peakValuation: portfolioState.peakValuation,
         drawdown: Number(drawdown.toFixed(4))
      });
    } catch(e: any) {
      const mapped = brokerPortfolioError(e);
      console.error("Broker Portfolio Error:", mapped.body.reason);
      res.status(mapped.status).json(mapped.body);
    }
  });

  app.post("/api/v1/portfolio/liquidate", tradingLimiter, async (req: Request, res: Response) => {
    try {
      const requested = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
      const broker = BrokerManager.getInstance().getActiveBroker();
      const portfolio = await broker.portfolio();
      const symbols = requested
        ? [requested]
        : portfolio.positions.filter((p) => p.quantity > 0).map((p) => p.symbol);
      if (symbols.length === 0) {
        return res.json({ ok: true, submitted: [], refused: [], message: "No open positions to flatten through the pipeline." });
      }
      const result = await submitPipelineSells(symbols);
      res.json({
        ok: result.refused.length === 0,
        ...result,
        note: "SELL ideas were emitted as CHIEF_APPROVED_IDEA. RiskEngine and OMS still run. This does not call broker.closePosition.",
      });
    } catch (e: any) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Real implementation (previously a permanent 501 refusal - see git history for why the naive
  // version was refused: closing/opening positions via broker.closePosition/placeOrder directly
  // bypasses RiskEngine). This submits one directional BUY/SELL idea per symbol whose real
  // current value drifts from its requested target by more than
  // tradingSafety.rebalanceMinDriftPctOfEquity, through the same CHIEF_APPROVED_IDEA pipeline
  // POST /portfolio/liquidate already uses - RiskEngine/OMS still run and still size every order.
  app.post("/api/v1/portfolio/rebalance", tradingLimiter, async (req: Request, res: Response) => {
    try {
      const validated = validateTargetAllocations(req.body?.targetAllocations);
      if (validated.ok === false) {
        return res.status(400).json({ ok: false, error: validated.error as string });
      }
      const result = await executeRebalance(validated.targets);
      res.json({
        ok: result.refused.length === 0,
        ...result,
        note: "Direction-only rebalance: BUY/SELL ideas were emitted as CHIEF_APPROVED_IDEA for symbols outside the drift tolerance. RiskEngine's own independent caps (order-notional, risk, buying-power, concentration, held-quantity for SELL) size the resulting orders - this does not guarantee landing exactly on the requested target percentages in one pass, and never calls broker.closePosition/placeOrder directly.",
      });
    } catch (e: any) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/v1/secrets", async (_req: Request, res: Response) => {
    res.json({ secrets: await secretsStatusFromEnvAndDb() });
  });

  app.put("/api/v1/secrets", async (req: Request, res: Response) => {
    const { values } = req.body;
    if (!values || typeof values !== 'object') {
      return res.status(400).json({ success: false, error: 'values object required' });
    }
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (SECRET_ALLOWLIST.has(k) && typeof v === 'string') filtered[k] = v;
    }
    try {
      const applied = await persistAllowlistedSecrets(filtered);
      res.json({ success: true, stored: 'sqlite_encrypted', applied });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/v1/secrets/test", async (req: Request, res: Response) => {
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    if (key === "ALPACA_API_KEY" || key === "ALPACA_SECRET_KEY" || key === "alpaca") {
      const apiKey = process.env.ALPACA_API_KEY;
      const secret = process.env.ALPACA_SECRET_KEY;
      if (!apiKey || !secret) {
        return res.json({ success: false, implemented: true, message: "ALPACA_API_KEY / ALPACA_SECRET_KEY are unset." });
      }
      try {
        const clockRes = await fetch("https://paper-api.alpaca.markets/v2/clock", {
          headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secret },
          signal: AbortSignal.timeout(4000),
        });
        return res.json({
          success: clockRes.ok,
          implemented: true,
          message: clockRes.ok ? "Alpaca clock reachable." : `Alpaca clock HTTP ${clockRes.status}`,
        });
      } catch (e: any) {
        return res.json({ success: false, implemented: true, message: e.message });
      }
    }
    res.json({
      success: false,
      implemented: false,
      message: "Live credential probe is only implemented for Alpaca. Other providers are not silently reported as OK.",
    });
  });

  app.use("/api/v1", integrationRouter);

  app.post("/api/v1/llm/consensus", aiLimiter, async (req: Request, res: Response) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const consensus = await callLLMConsensus(prompt);
    res.json(consensus);
  });

  // Legacy GET /api/v1/signals fabricated agent votes and wrote portfolio.json, bypassing
  // RiskEngine / OMS / trades. Quarantined: clients must use the live EventBus path.
  app.all("/api/v1/signals", (_req: Request, res: Response) => {
    res.status(410).json({
      error: "GONE",
      code: "SIGNALS_PATH_QUARANTINED",
      message: "GET /api/v1/signals is disabled. It fabricated consensus and bypassed RiskEngine. Use EventBus TRADE_IDEA_GENERATED → ChiefTrader → RiskEngine → OMS.",
    });
  });

  // Endpoint: Alpaca Integration - Get Configuration
  app.get("/api/v1/alpaca/config", (req: Request, res: Response) => {
    res.json({
      hasAlpacaKeys: !!(
        process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY
      ),
    });
  });

  // Endpoint: Alpaca Integration - Real Market Quote
  app.get("/api/v1/alpaca/quote", async (req: Request, res: Response) => {
    const symbol = req.query.symbol as string;
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      return res
        .status(400)
        .json({
          error: "Missing ALPACA_API_KEY or ALPACA_SECRET_KEY in Environment",
        });
    }
    
    const cached = marketDataWorker.getLatestPrice(symbol);
    if (cached && cached > 0) {
      return res.json({
        quotes: {
          [symbol]: {
            price: cached,
            source: 'market_data_worker'
          }
        }
      });
    }
    
    try {
      const response = await fetch(
        `https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=${symbol}`,
        {
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
          },
        },
      );
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      res.json(data);
    } catch (e: any) {
      res
        .status(500)
        .json({
          error: "Failed to reach Alpaca Markets Data API.",
          details: e.message,
        });
    }
  });

  // Endpoint: Alpaca Integration - Real Market News
  app.get("/api/v1/alpaca/news", async (req: Request, res: Response) => {
    try {
    const symbol = (req.query.symbol as string) || "";

    const respondInternal = async (alpacaReason: string) => {
      const internal = await loadInternalNewsForTicker(symbol);
      if (internal.available) {
        return res.json({
          ...internal,
          alpacaFallbackReason: alpacaReason,
        });
      }
      return res.json({
        available: false,
        news: [],
        source: internal.source,
        reason: `${alpacaReason}${internal.reason ? `; ${internal.reason}` : ""}`,
      });
    };

    // Check WebSocket first
    if (symbol && liveNews[symbol] && liveNews[symbol].length > 0) {
      return res.json({
        available: true,
        source: "alpaca-ws",
        news: liveNews[symbol].map((n: any) => ({
           id: n.id,
           headline: n.headline,
           summary: n.summary,
           author: n.author,
           created_at: n.created_at,
           updated_at: n.updated_at,
           url: n.url,
           source: n.source || "websocket",
           symbols: n.symbols || [symbol],
        })),
      });
    }

    if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
      try {
        const response = await fetch(
          `https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(symbol)}&limit=5`,
          {
            signal: AbortSignal.timeout(tradingSafety.alpacaRequestTimeoutMs),
            headers: {
              "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
              "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
            },
          },
        );
        if (response.ok) {
          const data = await response.json();
          const news = Array.isArray(data?.news) ? data.news : [];
          if (news.length > 0) {
            return res.json({ available: true, source: "alpaca", news });
          }
          return respondInternal("Alpaca news API returned no items");
        }
        return respondInternal(`Alpaca news API HTTP ${response.status}`);
      } catch (e: any) {
        return respondInternal(`Alpaca news API unreachable: ${e.message}`);
      }
    }

    return respondInternal("Alpaca API keys are not configured");
    } catch (e: any) {
      if (!res.headersSent) {
        res.json({
          available: false,
          news: [],
          reason: e?.message || "News lookup failed",
        });
      }
    }
  });

  // Endpoint: AI Co-Pilot Natural Language Trading (MCP Concept)
  app.post("/api/v1/mcp/trade", tradingLimiter, aiLimiter, async (req: Request, res: Response) => {
    const { prompt, broker = "Interactive Brokers (Paper)" } = req.body;
    if (!process.env.GEMINI_API_KEY) {
      return res
        .status(400)
        .json({
          error: "Gemini API Key required for Natural Language Trading.",
        });
    }

    try {
      const ai = null; // Removed Gemini dependency

      const tradeSchema = {
        type: "OBJECT",
        properties: {
          action: { type: "STRING", description: "Either BUY or SELL" },
          symbol: {
            type: "STRING",
            description: "The stock ticker symbol, e.g. AAPL",
          },
          quantity: { type: "NUMBER", description: "The number of shares" },
        },
        required: ["action", "symbol", "quantity"],
      };

      const response = await generateContentWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          systemInstruction:
            "You are an AI Trading Assistant in an Alpaca MCP integration. Extract the trade intent from user's natural language input. Output strictly valid JSON matching the schema of action, symbol, quantity.",
          responseMimeType: "application/json",
          responseSchema: tradeSchema as any,
        },
      });

      if (response.text) {
        const parsedRaw = response.text
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
        const parsedIntent = JSON.parse(parsedRaw);

        const sym = (parsedIntent.symbol || "AAPL").toUpperCase();

        res.json({
          success: true,
          extracted_intent: parsedIntent,
          message: `MCP Verification Complete: Extracted intention to ${parsedIntent.action} ${parsedIntent.quantity} shares of ${sym}. Ready for Execution verification.`,
          broker_target: broker,
        });
      } else {
        res
          .status(400)
          .json({
            error: "Could not parse trade intent from natural language.",
          });
      }
    } catch (e: any) {
      res
        .status(500)
        .json({ error: `Alpaca MCP Verification Failed: ${e.message}` });
    }
  });

  
    
  
  app.use("/api/v1", systemRouter);
  // Explicit full-path failsafe (same pattern as app.get('/api/v2/live-readiness') above).
  // Nested `app.use('/api/v1', systemRouter)` alone left a long-lived tsx process (started before
  // these handlers existed) returning catch-all "API route not found: /api/v1/system/pipeline-agents".
  // Registering on `app` with the exact SPA path cannot be stripped by a stale nested router.
  app.get('/api/v1/system/pipeline-agents', handlePipelineAgentsGet);
  app.post('/api/v1/system/pipeline-agents', tradingLimiter, handlePipelineAgentsPost);
  {
    const systemGets: string[] = [];
    const stack = (app as any)._router?.stack || [];
    for (const layer of stack) {
      if (layer?.route?.path && typeof layer.route.path === 'string' && layer.route.methods?.get) {
        if (layer.route.path.includes('/api/v1/system') || layer.route.path.includes('/system/')) {
          systemGets.push(`GET ${layer.route.path}`);
        }
      }
      if (layer?.name === 'router' && layer?.regexp) {
        const nested = layer.handle?.stack || [];
        for (const n of nested) {
          if (n?.route?.path && n.route.methods?.get && String(n.route.path).includes('system')) {
            systemGets.push(`GET ${n.route.path} (via /api/v1 router)`);
          }
        }
      }
    }
    console.log(`[boot] GET /api/v1/system/* registrations (${systemGets.length}): ${systemGets.join(' | ') || '(none)'}`);
    const hasPipeline = systemGets.some((s) => s.includes('pipeline-agents'));
    if (!hasPipeline) {
      console.error('[boot] FATAL-ISH: pipeline-agents GET not visible in Express stack — Mission Control will 404');
    } else {
      console.log('[boot] pipeline-agents explicit + router mounts OK');
    }
  }

  app.post("/api/v1/llm/dual-verify-trade", tradingLimiter, aiLimiter, async (req: Request, res: Response) => {
    return res.status(410).json({
      error: "GONE",
      code: "DUAL_VERIFY_QUARANTINED",
      message: "This sandbox invented BUY/SELL JSON without EventBus, ChiefTrader, RiskEngine, or OMS.",
    });
  });

  app.post("/api/v1/event-memory/feedback", (_req, res) => {
    res.status(410).json({
      ok: false,
      code: "EVENT_MEMORY_QUARANTINED",
      what: "Fabricated vector event-memory",
      why: "GET /api/v1/event-memory previously returned canned 82% Trade War text and pseudo-scores.",
      impact: "That endpoint must not be used as model memory or trade evidence.",
      howToFix: "Use persisted trades, event_traces, and GET /api/v2/desk/lifecycle. Do not restore the canned matcher.",
    });
  });

  app.get("/api/v1/event-memory", (_req: Request, res: Response) => {
    res.status(410).json({
      ok: false,
      code: "EVENT_MEMORY_QUARANTINED",
      available: false,
      summary: "NO HISTORICAL DATA",
      matches: [],
      what: "Semantic event memory",
      why: "No real vector memory index exists. The previous handler invented precedents.",
      impact: "Precedent search cannot inform trades. Decision history is SQLite, not this route.",
      howToFix: "Query GET /api/v2/desk/lifecycle and GET /api/v2/data/trades. Do not fabricate similarity scores.",
    });
  });

  // --- LIVE NEWS SEARCH GROUNDING ---
  app.use("/api/v1/news", newsRouter);

  // --- SHADOW PORTFOLIO (ledger only; never BrokerManager.placeOrder) ---
  function executeAutoBotTradeInShadow(symbol: string, side: string, price: number, amount: number) {
    const qty = amount / price;
    if (side === "BUY") {
      shadowPortfolioState.cash = Number((shadowPortfolioState.cash - amount).toFixed(2));
      const posIndex = shadowPortfolioState.positions.findIndex((p: any) => p.symbol === symbol);
      if (posIndex !== -1) {
        const pos = shadowPortfolioState.positions[posIndex];
        pos.quantity = Number((pos.quantity + qty).toFixed(4));
        pos.totalCost = Number((pos.totalCost + amount).toFixed(2));
        pos.marketValue = Number((pos.quantity * price).toFixed(2));
        pos.unrealizedPnl = Number((pos.marketValue - pos.totalCost).toFixed(2));
        pos.unrealizedPnlPercent = Number(pos.totalCost > 0 ? (pos.unrealizedPnl / pos.totalCost).toFixed(4) : "0");
      } else {
        shadowPortfolioState.positions.push({
          symbol,
          quantity: Number(qty.toFixed(4)),
          entryPrice: Number(price.toFixed(2)),
          currentPrice: Number(price.toFixed(2)),
          totalCost: Number(amount.toFixed(2)),
          marketValue: Number(amount.toFixed(2)),
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          sector: symbol === "SPY" ? "Index Funds" : "Technology",
          openedAt: new Date().toISOString()
        });
      }
      saveShadowPortfolio(shadowPortfolioState);
    } else if (side === "SELL") {
      const posIndex = shadowPortfolioState.positions.findIndex((p: any) => p.symbol === symbol);
      if (posIndex !== -1) {
        const pos = shadowPortfolioState.positions[posIndex];
        const sellQty = Math.min(pos.quantity, qty);
        const sellValue = sellQty * price;
        pos.quantity = Number((pos.quantity - sellQty).toFixed(4));
        pos.totalCost = Number(Math.max(0, pos.totalCost - (pos.totalCost / (pos.quantity + sellQty)) * sellQty).toFixed(2));
        pos.marketValue = Number((pos.quantity * price).toFixed(2));
        pos.unrealizedPnl = Number((pos.marketValue - pos.totalCost).toFixed(2));
        pos.unrealizedPnlPercent = Number(pos.totalCost > 0 ? (pos.unrealizedPnl / pos.totalCost).toFixed(4) : "0");
        shadowPortfolioState.cash = Number((shadowPortfolioState.cash + sellValue).toFixed(2));
        if (pos.quantity <= 0.01) {
          shadowPortfolioState.positions.splice(posIndex, 1);
        }
        saveShadowPortfolio(shadowPortfolioState);
      }
    }
  }

  async function stepPortfolioPrices() {
    // Update Shadow Portfolio position marks from real live ticks (MarketDataWorker).
    // Falls back to the position's last known real price if no tick has arrived yet -
    // never fabricates a price.
    if (shadowPortfolioState && shadowPortfolioState.positions) {
      shadowPortfolioState.positions.forEach((pos: any) => {
        const liveTick = marketDataWorker.getLatestPrice(pos.symbol);
        if (typeof liveTick === 'number' && liveTick > 0) pos.currentPrice = liveTick;
        pos.marketValue = Number((pos.quantity * pos.currentPrice).toFixed(2));
        pos.unrealizedPnl = Number((pos.marketValue - pos.totalCost).toFixed(2));
        pos.unrealizedPnlPercent = Number(pos.totalCost > 0 ? (pos.unrealizedPnl / pos.totalCost).toFixed(4) : "0");
      });
      saveShadowPortfolio(shadowPortfolioState);
    }

    // Sovereign equity comes from the real broker portfolio (the same accessor RiskEngine
    // uses) - not the legacy portfolioState JSON, which still carries pre-seeded demo data.
    let sovEquity: number;
    try {
      const broker = BrokerManager.getInstance().getActiveBroker();
      const portfolio = await broker.portfolio();
      sovEquity = Number(portfolio.equity) || 0;
    } catch (e) {
      console.error('[ShadowBenchmark] Failed to fetch real broker equity for equity curve', e);
      return;
    }

    const shadEquity = shadowPortfolioState.cash + shadowPortfolioState.positions.reduce((sum: number, p: any) => sum + p.marketValue, 0);

    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    tradingEngine.state.equityHistory.push({
      time: timeLabel,
      sovereign: Number(sovEquity.toFixed(2)),
      shadow: Number(shadEquity.toFixed(2))
    });

    if (tradingEngine.state.equityHistory.length > 35) {
      tradingEngine.state.equityHistory.shift();
    }
  }

  // Mirrors RiskEngine-approved OMS fills into the unconstrained Shadow Portfolio for the
  // ShadowPortfolioBenchmark "Shadow" line. Never places a broker order. Does NOT book on
  // CHIEF_APPROVED_IDEA (that predated RiskEngine and looked like paper P&L).
  eventBus.on('ORDER_EXECUTED', (order: any) => {
    if (order?.status !== 'FILLED') return;
    if (order?.side !== 'BUY' && order?.side !== 'SELL') return;
    const env = String(order.executionEnvironment || '').toUpperCase();
    if (env === 'REPLAY' || env === 'BACKTEST' || env === 'SIMULATION') return;
    if (typeof order.traceId === 'string' && order.traceId.startsWith('replay-')) return;
    const price = Number(order.price);
    const qty = Number(order.quantity);
    if (!(price > 0) || !(qty > 0)) return;
    executeAutoBotTradeInShadow(order.symbol, order.side, price, price * qty);
  });

  // Logs every Risk Engine veto to the bypassed-trades ledger shown by ShadowPortfolioBenchmark.
  // Only real fields from the emitted assessment are recorded.
  eventBus.on('RISK_ASSESSMENT_COMPLETED', (assessment: any) => {
    if (!assessment.approved) {
      tradingEngine.state.bypassedTrades.unshift({
        time: new Date().toISOString(),
        symbol: assessment.symbol,
        side: assessment.side,
        reason: assessment.reasoning,
        price: assessment.currentPrice,
        amount: typeof assessment.currentPrice === 'number' ? tradingEngine.state.maxTradeSize : undefined
      });
      if (tradingEngine.state.bypassedTrades.length > 50) tradingEngine.state.bypassedTrades.pop();
    }
  });

  setInterval(() => { stepPortfolioPrices().catch(e => console.error('[ShadowBenchmark] stepPortfolioPrices failed', e)); }, 60000);


  



  app.use("/api/v1/chaos", chaosRouter);

  // Endpoints for Prompt Evolution
  app.use("/api/v1/autobot", autobotRouter);
  // Fresh /health probe — sync getStatus() can stay UNAVAILABLE for up to kronosRecheckMs
  // after Chronos finishes loading (common: Node booted while HF model still downloading).
  app.get("/api/v1/kronos/status", async (_req, res) => {
    try {
      res.json(await kronosEngine.getStatusFresh());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Serves Static build directory of React SPA client in production
  if (isProd) {
    app.use(express.static(path.join(dirName, "dist")));
    app.get("*", (req: Request, res: Response, next) => {
      if (req.path.startsWith('/ws') || req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(path.join(dirName, "dist/index.html"));
    });
  }

  const PORT = 3000;
  // Bug Fix: HMR Port Collision
  // Create HTTP server first, then pass to Vite HMR
  const httpServer = http.createServer(app);

  app.use((err, req, res, next) => {
    console.error('Unhandled API Error:', err);
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    } else {
      next(err);
    }
  });

  // Last-chance explicit registration immediately before the catch-all (live-readiness pattern:
  // full path on `app`, not a nested Router). First matching route wins; duplicates are harmless.
  app.get('/api/v1/system/pipeline-agents', handlePipelineAgentsGet);
  app.post('/api/v1/system/pipeline-agents', tradingLimiter, handlePipelineAgentsPost);

  app.all('/api/*', (req, res) => {
    // Prefer req.originalUrl so nested mount stripping does not hide the full path operators hit.
    const shown = req.originalUrl?.split('?')[0] || req.path;
    console.warn(`[api-404] ${req.method} ${shown}`);
    res.status(404).json({ error: 'API route not found: ' + shown });
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  
  const wss = new WebSocketServer({ noServer: true });

  // WebSocket connections previously bypassed auth entirely - the HTTP auth middleware only
  // gates paths starting with /api/, and 'upgrade' events never reach Express's request pipeline
  // at all. The /ws stream carries every EventBus event (trade ideas, risk decisions, order
  // fills), so when AUTH_PASSWORD is configured, require the same session cookie the HTTP API
  // requires. Matches the HTTP middleware's own behavior when auth is unconfigured: allow through.
  async function isWsAuthed(request: import('http').IncomingMessage): Promise<boolean> {
    if (!AUTH_ENABLED) return true;
    const cookies = request.headers.cookie || "";
    const match = cookies.match(new RegExp(SESSION_COOKIE + "=([^;]+)"));
    const token = match ? match[1] : null;
    if (!token) return false;
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionToken, token)).limit(1);
    return isSessionValid(rows[0] ?? null);
  }

  httpServer.on('upgrade', (request, socket, head) => {
    (async () => {
      try {
        const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
        if (pathname !== '/ws') return;
        // Rate-limit connection *creation* (not messages on an already-open socket) - the
        // Express rate limiter below only ever sees HTTP requests, never the raw 'upgrade' event,
        // so WS needs its own counter to stop a connection-flood from this same class of abuse.
        const remoteIp = request.socket.remoteAddress || 'unknown';
        if (!wsUpgradeLimiter.allow(remoteIp)) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }
        if (!(await isWsAuthed(request))) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } catch (e) {
        socket.destroy();
      }
    })();
  });
  setGlobalWss(wss);
  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {}
    });

    
    // Forward all events via wildcard. EventBus's wildcard emit calls listeners
    // as (eventName, ...args) - not as a single object - so the handler must
    // destructure it that way or it silently drops the real payload.
    const wildcardHandler = (eventName: string, payload: any) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({ type: eventName, data: payload }));
      }
    };
    eventBus.on('*', wildcardHandler);

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      eventBus.off('*', wildcardHandler);
    });
  });

  setInterval(() => {
    BrokerManager.getInstance().tick(marketDataWorker.getLatestPrices());
  }, 1000);
  
  // Broadcast AutoBot state to all connected clients
  setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify({
          type: 'AUTOBOT_STATE_UPDATED',
          data: {
            ...tradingEngine.state,
            enabled: tradingEngine.state.enabled,
            autoBotEnabled: tradingEngine.state.enabled,
            remaining: tradingEngine.state.budget - tradingEngine.state.spent,
            scheduleWindow: tradingEngine.getScheduleWindowStatus(),
          },
        }));
      }
    });
  }, 2000);

  httpServer.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error('Address in use, exiting...');
      process.exit(1);
    }
  });
  // Fail-closed network posture: without AUTH_PASSWORD, bind loopback only so LAN/WAN cannot hit open APIs.
  const bindHost = AUTH_ENABLED ? '0.0.0.0' : '127.0.0.1';
  httpServer.listen(PORT, bindHost, () => {
    if (!AUTH_ENABLED) {
      console.warn('WARNING: AUTH_PASSWORD NOT SET. API BOUND TO LOCALHOST ONLY.');
    }
    console.log(`Enterprise scale multi-agent backend running on ${bindHost}:${PORT}`);
  });
}

startServer();

let globalWss: any = null;
export const setGlobalWss = (w: any) => globalWss = w;
export const getGlobalWss = () => globalWss;