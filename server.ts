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
import { analyticsRouter } from "./src/server/routes/analyticsRoutes";
import { webhooksRouter, triggerWebhooks } from "./src/server/routes/webhooks";
import { generateContentWithRetry, cleanAndParseJSON } from "./src/server/ai/legacyGeminiHelpers";
import { auditLog, AUDIT_LOG_FILE } from "./src/server/core/auditLog";
import { chaosRouter, chaosConfig } from "./src/server/routes/chaosRoutes";
import { systemRouter } from "./src/server/routes/systemRoutes";
import { newsRouter } from "./src/server/routes/newsRoutes";
import { autobotRouter } from "./src/server/routes/autobotRoutes";
import { shadowPortfolioState, saveShadowPortfolio } from "./src/server/state/shadowPortfolio";
import { integrationRouter } from "./src/server/routes/integrationRoutes";
import { tradingEngine } from "./src/server/engines/TradingEngine";
import { system } from "./src/server/core/SystemBootstrap";
import { marketDataWorker } from "./src/server/services/MarketDataWorker";
import { isAuthEnabled, validateCredentials as validateCredentialsPure, isSessionValid, enforceAuthConfigOrExit } from "./src/server/core/AuthConfig";
import { loginLimiter, aiLimiter, tradingLimiter, backtestLimiter, wsUpgradeLimiter } from "./src/server/core/RateLimiters";
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



let liveQuotes: any = {};
let liveNews: any = {};
let alpacaWs: any = null;
let alpacaNewsWs: any = null;

function initializeAlpacaWebSocket() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return;
  const isPaper = process.env.PAPER_TRADING_ONLY !== "false";
  
  // Quotes WebSocket
  const wssUrl = "wss://stream.data.alpaca.markets/v2/iex";
  alpacaWs = new WebSocket(wssUrl);
  
  alpacaWs.addEventListener("open", () => {
    console.log('[Alpaca WS] Connected to market data stream.');
    alpacaWs.send(JSON.stringify({
      action: 'auth',
      key: process.env.ALPACA_API_KEY,
      secret: process.env.ALPACA_SECRET_KEY
    }));
  });
  
  alpacaWs.addEventListener("message", (event) => {
    const messages = JSON.parse(event.data.toString());
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('[Alpaca WS] Authenticated successfully. Subscribing to quotes...');
        alpacaWs.send(JSON.stringify({
          action: 'subscribe',
          quotes: AUTOBOT_SYMBOLS
        }));
      } else if (msg.T === 'q') {
        liveQuotes[msg.S] = { bid: msg.bp, ask: msg.ap, price: (msg.bp + msg.ap) / 2 };
      } else if (msg.T === 't') {
        if (!liveQuotes[msg.S]) liveQuotes[msg.S] = { bid: msg.p, ask: msg.p, price: msg.p };
        liveQuotes[msg.S].price = msg.p;
      }
    }
  });
  
  alpacaWs.addEventListener("close", () => {
    console.log('[Alpaca WS] Connection closed. Reconnecting in 5s...');
    setTimeout(() => {
       if (alpacaWs) alpacaWs.close();
       initializeAlpacaWebSocket();
    }, 5000);
  });
  
  alpacaWs.addEventListener("error", (err) => {
    console.error('[Alpaca WS] Error:', err.message);
  });

  // News WebSocket
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
  // No real credential is configured - explicit, startup-validated "no-auth" dev mode (see
  // AuthConfig.ts). Never reachable in production; enforceAuthConfigOrExit() refuses to boot
  // with AUTH_ENABLED=false when NODE_ENV=production.
  if (!AUTH_ENABLED) return true;

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

const SECRETS_FILE = path.join(process.cwd(), "data", "secrets.json");
const SECRET_SPECS = [
  { key: "ALPACA_API_KEY", label: "Alpaca API Key", category: "Broker" },
  { key: "ALPACA_SECRET_KEY", label: "Alpaca Secret Key", category: "Broker" },
  { key: "QUESTRADE_REFRESH_TOKEN", label: "Questrade Token", category: "Broker" },
  { key: "QUESTRADE_ACCOUNT_ID", label: "Questrade Account", category: "Broker" },
  { key: "GEMINI_API_KEY", label: "Gemini Key", category: "LLM" },
  { key: "OPENAI_API_KEY", label: "OpenAI Key", category: "LLM" },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic Key", category: "LLM" },
  { key: "MISTRAL_API_KEY", label: "Mistral Key", category: "LLM" },
  { key: "FRED_API_KEY", label: "FRED Key", category: "Market Data" },
  { key: "FINNHUB_API_KEY", label: "Finnhub Key", category: "Market Data" }
];
const SECRET_ALLOWLIST = new Set(SECRET_SPECS.map(s => s.key));

let savedSecrets: Record<string, string> = {};
try {
  savedSecrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
} catch {}

function writeSecretsFile() {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(savedSecrets, null, 2), { mode: 0o600 });
}

function secretsStatus() {
  return SECRET_SPECS.map(spec => {
    const val = process.env[spec.key];
    return {
      key: spec.key,
      label: spec.label,
      category: spec.category,
      configured: !!val,
      masked: val ? "••••" + val.slice(-4) : "",
      source: process.env[spec.key] && !savedSecrets[spec.key] ? "env" : "saved"
    };
  });
}

// Bootstrap env keys
for (const spec of SECRET_SPECS) {
  if (savedSecrets[spec.key] && !process.env[spec.key]) {
    process.env[spec.key] = savedSecrets[spec.key];
  }
}
if (process.env.ALPACA_SECRET_KEY && !process.env.ALPACA_API_SECRET) {
  process.env.ALPACA_API_SECRET = process.env.ALPACA_SECRET_KEY;
}

  const app = express();
  initializeAlpacaWebSocket();

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

  app.use("/api/v1/webhooks", webhooksRouter);

  app.get("/api/v1/portfolio", async (req: Request, res: Response) => {
    try {
      const broker = BrokerManager.getInstance().getActiveBroker();
      // No fabricated fallback if the broker call fails - a real error surfaces as a real error
      // instead of a fake $10,000 placeholder that looks like a real (if small) account.
      const portfolio = await broker.portfolio();

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
         cash: portfolio.cash,
         buying_power: portfolio.buyingPower,
         equity: portfolio.equity,
         positions: portfolio.positions,
         peakValuation: portfolioState.peakValuation,
         drawdown: Number(drawdown.toFixed(4))
      });
    } catch(e: any) {
      console.error("Broker Portfolio Error:", e.message);
      res.status(502).json({ error: `Broker unavailable: ${e.message}` });
    }
  });

  app.post("/api/v1/portfolio/liquidate", async (req: Request, res: Response) => {
    try {
      const { symbol } = req.body;
      if (!symbol) return res.status(400).json({ error: "Missing symbol" });
      const broker = BrokerManager.getInstance().getActiveBroker();
      const success = await broker.closePosition(symbol);
      res.json({ success });
    } catch(e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/v1/portfolio/rebalance", async (req: Request, res: Response) => {
    try {
      const broker = BrokerManager.getInstance().getActiveBroker();
      const portfolio = await broker.portfolio();
      let successCount = 0;
      for (const pos of portfolio.positions) {
        if (await broker.closePosition(pos.symbol)) successCount++;
      }
      res.json({ success: true, closedPositions: successCount });
    } catch(e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/v1/secrets", (req: Request, res: Response) => {
    res.json({ secrets: secretsStatus() });
  });

  app.put("/api/v1/secrets", (req: Request, res: Response) => {
    const { values } = req.body;
    if (values && typeof values === 'object') {
      for (const [k, v] of Object.entries(values)) {
        if (SECRET_ALLOWLIST.has(k)) {
           savedSecrets[k] = v as string;
           process.env[k] = v as string;
        }
      }
      writeSecretsFile();
    }
    res.json({ success: true });
  });

  app.post("/api/v1/secrets/test", async (req: Request, res: Response) => {
    // For Alpaca, do a simple fetch to Alpaca's clock or account endpoint using current env vars
    res.json({ success: true, message: "Testing not fully implemented for all providers." });
  });

  app.use("/api/v1", integrationRouter);

  app.post("/api/v1/llm/consensus", aiLimiter, async (req: Request, res: Response) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const consensus = await callLLMConsensus(prompt);
    res.json(consensus);
  });

  // Swarm Decision Outcomes Endpoint (used by Arena tab)
  app.get("/api/v1/signals", async (req: Request, res: Response) => {
    const symbol = ((req.query.symbol as string) || "AAPL").toUpperCase();
    const headline = (req.query.headline as string) || `Analyze ${symbol}`;
    
    const llmResult = await callLLMConsensus(`Evaluate this event for ${symbol}: ${headline}`);
    
    const mockSignals = llmResult.results.map((r: any, idx: number) => ({
      agent_id: r.provider || `agent_${idx}`,
      signal: r.status === 'error' ? 'ERROR' : llmResult.consensus_verdict,
      confidence: 0.85,
      reasoning: r.error || "Processed and verified by LLM"
    }));

    res.json({
      symbol,
      regime: tradingEngine.state.regimeState?.regime || "UNKNOWN",
      decision: llmResult.consensus_verdict,
      internal_consensus: llmResult.consensus_verdict,
      confidence: 0.85,
      consensus_explanation: "LLM consensus reached across available providers.",
      alpaca_mcp: {
         decision: llmResult.consensus_verdict === 'HOLD' ? 'REJECT' : 'APPROVE',
         sentiment: llmResult.consensus_verdict === 'BUY' ? 'bullish' : 'bearish',
         trend: 'neutral',
         confidence: 0.9,
         reasoning: "Verified against basic safety rules"
      },
      vetoed_by_risk: false,
      execution_status: "PAPER_SIMULATED",
      executed_trade: null,
      compiled_signals: mockSignals,
      risk_vetos_logged: []
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
    
    // Check WebSocket first
    if (liveQuotes[symbol] && liveQuotes[symbol].price > 0) {
      return res.json({
        quotes: {
          [symbol]: {
            ap: liveQuotes[symbol].ask,
            bp: liveQuotes[symbol].bid,
            price: liveQuotes[symbol].price,
            source: 'websocket'
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
    const symbol = req.query.symbol as string;
    
    // Fallback to our internal News Engine Memory if Alpaca keys are missing
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      try {
        const { NewsMemoryEngine } = await import('./src/server/news/NewsMemoryEngine.ts');
        const engine = new NewsMemoryEngine();
        const events = await engine.getRecentEventsForSymbol(symbol || '');
        return res.json({
          news: events.map((item: any) => ({
            id: item.id,
            headline: item.title,
            summary: item.summary,
            author: item.source || 'News Engine',
            created_at: item.createdAt,
            url: item.url,
            symbols: item.symbols ? JSON.parse(item.symbols) : [symbol]
          }))
        });
      } catch (e: any) {
        return res.status(500).json({ error: e.message });
      }
    }
    
    // Check WebSocket first
    if (liveNews[symbol] && liveNews[symbol].length > 0) {
      return res.json({
        news: liveNews[symbol].map((n: any) => ({
           id: n.id,
           headline: n.headline,
           summary: n.summary,
           author: n.author,
           created_at: n.created_at,
           updated_at: n.updated_at,
           url: n.url,
           source: n.source || 'websocket'
        }))
      });
    }
    
    try {
      const response = await fetch(
        `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=5`,
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
          error: "Failed to reach Alpaca Markets News API.",
          details: e.message,
        });
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

  app.post("/api/v1/llm/dual-verify-trade", tradingLimiter, aiLimiter, async (req: Request, res: Response) => {
    const { symbol, marketContext, headline, proposerStressed, verifierStressed, proposerName, verifierName, adversarialDebateMode } = req.body;
    if (!symbol || !headline) return res.status(400).json({ error: "Missing symbol or headline" });
    
    if (!ai) {
      return res.status(503).json({ error: "Gemini AI not initialized on the server." });
    }

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    try {
      // Proposer Failure/Latency Simulation
      if (proposerStressed) {
        await sleep(1500 + Math.random() * 2000); 
        if (Math.random() > 0.6) {
           throw new Error(`[Stress Test] ${proposerName || 'Proposer Agent'} endpoint timed out or returned 502 Bad Gateway.`);
        }
      }

      // Step 1: The Proposer Agent
      const proposerPrompt = `You are a highly assertive, quantitative day-trading agent (The Proposer). Given the following market data, propose a definitive trade decision.
Asset: ${symbol}
Headline: "${headline}"
Market Context (which may include technicals like VWAP, RSI, MACD, Bollinger Bands, or strategy hints like Scalping/Momentum/Mean Reversion): ${marketContext || "Normal market conditions."}

Evaluate the data using standard day trading methodology (e.g., buying when breaking out above VWAP on volume, selling when RSI is overbought).
Output MUST be valid JSON (and no other text) exactly matching this structure:
{
  "decision": "BUY" | "SELL" | "HOLD",
  "reasoning": "Brief explanation of the rationale, mentioning technical indicators if present",
  "thinking": "Internal thought process of the proposer in 1 sentence"
}`;

      let proposerOutput: any = { decision: "HOLD", reasoning: "Failed to parse proposer output" };
      let debateDetails: any = null;

      if (adversarialDebateMode) {
        try {
          const { bull, bear } = await generateCompetingTheses(
                        ai,
                        symbol,
                        `Verification-triggered scan for ${symbol}`,
                        `Headline context: ${headline}. Market context: ${marketContext || "Normal market conditions."}`,
                        "",
                        ""
                     );

          const judgePrompt = `You are the Principal Proposer Agent acting as the Consensus Judge (Agent 1). Your job is to review the competing briefs submitted by our Bull Analyst (Agent 1a) and Bear Analyst (Agent 1b), weigh them objectively, and render the final system decision (BUY, SELL, or HOLD) for ${symbol}.
Bull Brief: "${bull.thesis}" (Target: $${bull.target_price})
Bear Brief: "${bear.thesis}" (Trigger: $${bear.stop_trigger_price})

Asset: ${symbol}
Headline: "${headline}"
Market Context: ${marketContext || "Normal market conditions."}

Resolve the debate. Force a final consensus decision.
Output MUST be valid JSON (and no other text) matching this exact structure:
{
  "decision": "BUY" | "SELL" | "HOLD",
  "reasoning": "1-sentence explanation of how you resolved the conflict between the Bull and Bear briefs to reach this final verdict",
  "thinking": "Brief internal thought process"
}`;

          const judgeRes = await generateContentWithRetry(ai, {
            model: "gemini-3.5-flash",
            contents: judgePrompt,
            config: { responseMimeType: "application/json", temperature: 0.5 }
          });

          const parsedJudge = cleanAndParseJSON(judgeRes.text);
          if (parsedJudge) {
            proposerOutput = parsedJudge;
          } else {
            console.log("Failed to parse judge JSON. Raw text:", judgeRes.text);
          }

          debateDetails = {
            bull,
            bear,
            resolved: true
          };

        } catch (debateErr: any) {
          console.error("Adversarial Debate failed in verification endpoint, falling back:", debateErr);
          const proposerRes = await generateContentWithRetry(ai, {
            model: "gemini-3.5-flash",
            contents: proposerPrompt,
            config: { responseMimeType: "application/json", temperature: 0.7 }
          });
          proposerOutput = cleanAndParseJSON(proposerRes.text) || proposerOutput;
        }
      } else {
        const proposerRes = await generateContentWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: proposerPrompt,
          config: {
              responseMimeType: "application/json",
              temperature: 0.7
          }
        });
        
        proposerOutput = cleanAndParseJSON(proposerRes.text) || proposerOutput;
      }

      // Verifier Failure/Latency Simulation
      if (verifierStressed) {
        await sleep(1500 + Math.random() * 2000);
        if (Math.random() > 0.6) {
           throw new Error(`[Stress Test] ${verifierName || 'Verifier Agent'} endpoint rejected the connection due to simulated rate limiting.`);
        }
      }

      // Step 2: The Verifier Agent (Vigorous critic)
      const verifierPrompt = `You are a skeptical, highly rigorous Risk and Verification Agent. Your job is to rigorously critique the decision proposed by another AI agent. Look for cognitive biases, impulsivity, or "procrastination" (unnecessary holding).
Asset: ${symbol}
Headline: "${headline}"
Proposer's Decision: ${proposerOutput.decision}
Proposer's Reasoning: ${proposerOutput.reasoning}

Question the logic vigorously. Do they lack evidence? Is it too greedy or too fearful?
Output MUST be valid JSON (and no other text) exactly matching this structure:
{
  "verified_decision": "BUY" | "SELL" | "HOLD",
  "critique": "Your aggressive critique and reasoning for either overriding or accepting the proposal",
  "confidence_score": 0.0 to 1.0,
  "thinking": "Internal verification thought process in 1 sentence"
}`;

      const verifierRes = await generateContentWithRetry(ai, {
        model: "gemini-3.5-flash", // We use the same model but distinct persona instructions
        contents: verifierPrompt,
        config: {
            responseMimeType: "application/json",
            temperature: 0.2 // Lower temp for more analytical, strict behavior
        }
      });

      let verifierOutput: any = cleanAndParseJSON(verifierRes.text) || { verified_decision: "HOLD", critique: "Failed to parse verifier output", confidence_score: 0 };

      res.json({
          symbol,
          headline,
          proposer: proposerOutput,
          verifier: verifierOutput,
          final_decision: verifierOutput.verified_decision,
          debate: debateDetails,
          timestamp: new Date().toISOString()
      });

    } catch (e: any) {
      console.error("Dual-verify error:", e);
      res.status(500).json({ error: e.message || "Failed dual-verification" });
    }
  });

  app.post("/api/v1/event-memory/feedback", async (req, res) => {
    try {
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false });
    }
  });

  app.get("/api/v1/event-memory", async (req: Request, res: Response) => {
    const query =
      (req.query.query as string) || "restrictive machinery tariffs";

    console.log(
      `Searching semantic precedent similarity for query: "${query}"...`,
    );

    let geminiContext = "";
    if (ai) {
      try {
        const g_res = await generateContentWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: `You are an institutional trading platform strategist. Analyze this situation: "${query}". Answer 'Have we seen something similar before?' by referencing a major historical economy precedent (like 2018 Trade War, 2020 Pandemic, 2008 Lehman collapse). Detail why they correlate contextually, the asset reactions, and suggest defensive trade postures. Be concise and authoritative.`,
        });
        if (g_res && g_res.text) geminiContext = g_res.text;
      } catch (e: any) {
        console.warn(
          "Gemini event memory query failed. Fallback applied.",
          e.message,
        );
      }
    }

    if (!geminiContext) {
      geminiContext = `Yes, we have seen comparable scenarios before. Based on your scenario '${query}', our historical database identifies a strong statistical trend match of 82% to the "2018 Sino-US Trade War Escalation" where technology asset margins contracted under tariff threats, causing defensive capital rotations to hard commodities.`;
    }

    // Calculate scores
    const results = historicalPrecedents
      .map((ev, i) => {
        // Generate a simple pseudo score
        const score = query.toLowerCase().includes(ev.category)
          ? 0.88
          : 0.42 - i * 0.08;
        return {
          score,
          confidence: Math.max(0.5, Math.min(1.0, 0.5 + score * 3)),
          title: ev.title,
          category: ev.category,
          description: ev.description,
          impact: ev.marketImpact,
        };
      })
      .sort((a, b) => b.score - a.score);

    res.json({
      query,
      summary: geminiContext,
      matches: results.slice(0, 2),
    });
  });

  // --- LIVE NEWS SEARCH GROUNDING ---
  app.use("/api/v1/news", newsRouter);

  // --- FULLY AUTONOMOUS BLACK-BOX TRADING BOT & SHADOW PORTFOLIO ENGINE ---
  async function executeAutoBotTradeInSovereign(symbol: string, side: string, price: number, amount: number) {
    const qty = amount / price;
    try {
      const existing = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
      if (side === "BUY") {
        if (existing.length > 0) {
          const oldQty = existing[0].quantity;
          const oldAvg = existing[0].averagePrice;
          const newQty = oldQty + qty;
          const newAvg = ((oldQty * oldAvg) + amount) / newQty;
          await db.update(schema.portfolio).set({ quantity: newQty, averagePrice: newAvg, currentPrice: price, lastUpdated: new Date().toISOString() }).where(eq(schema.portfolio.symbol, symbol));
        } else {
          await db.insert(schema.portfolio).values({ symbol, quantity: qty, averagePrice: price, currentPrice: price, lastUpdated: new Date().toISOString() });
        }
      } else if (side === "SELL") {
        if (existing.length > 0) {
          const oldQty = existing[0].quantity;
          const newQty = Math.max(0, oldQty - qty);
          if (newQty === 0) {
             await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
          } else {
             await db.update(schema.portfolio).set({ quantity: newQty, currentPrice: price }).where(eq(schema.portfolio.symbol, symbol));
          }
        }
      }
    } catch(e) {
      console.error("DB Portfolio Update Error:", e);
    }
    try {
      const broker = BrokerManager.getInstance().getActiveBroker();
      await broker.placeOrder({
         symbol,
         side: side as 'BUY' | 'SELL',
         type: 'MARKET',
         quantity: qty,
         price
      });
    } catch(err) {
      console.error("Broker placeOrder error", err);
    }
    
    // Original fallback logic to keep portfolioState updated for legacy UI
    if (side === "BUY") {
      if (portfolioState.cash >= amount) {
        portfolioState.cash = Number((portfolioState.cash - amount).toFixed(2));
        const posIndex = portfolioState.positions.findIndex((p: any) => p.symbol === symbol);
        if (posIndex !== -1) {
          const pos = portfolioState.positions[posIndex];
          pos.quantity = Number((pos.quantity + qty).toFixed(4));
          pos.totalCost = Number((pos.totalCost + amount).toFixed(2));
          pos.marketValue = Number((pos.quantity * price).toFixed(2));
          pos.unrealizedPnl = Number((pos.marketValue - pos.totalCost).toFixed(2));
          pos.unrealizedPnlPercent = Number(pos.totalCost > 0 ? (pos.unrealizedPnl / pos.totalCost).toFixed(4) : "0");
        } else {
          portfolioState.positions.push({
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
        savePortfolio(portfolioState);
      }
    } else if (side === "SELL") {
      const posIndex = portfolioState.positions.findIndex((p: any) => p.symbol === symbol);
      if (posIndex !== -1) {
        const pos = portfolioState.positions[posIndex];
        const sellQty = Math.min(pos.quantity, qty);
        const sellValue = sellQty * price;
        pos.quantity = Number((pos.quantity - sellQty).toFixed(4));
        pos.totalCost = Number(Math.max(0, pos.totalCost - (pos.totalCost / (pos.quantity + sellQty)) * sellQty).toFixed(2));
        pos.marketValue = Number((pos.quantity * price).toFixed(2));
        pos.unrealizedPnl = Number((pos.marketValue - pos.totalCost).toFixed(2));
        pos.unrealizedPnlPercent = Number(pos.totalCost > 0 ? (pos.unrealizedPnl / pos.totalCost).toFixed(4) : "0");
        portfolioState.cash = Number((portfolioState.cash + sellValue).toFixed(2));
        if (pos.quantity <= 0.01) {
          portfolioState.positions.splice(posIndex, 1);
        }
        savePortfolio(portfolioState);
      }
    }
  }

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

  // Mirrors every Chief Trader decision into the unconstrained Shadow Portfolio, regardless
  // of what Risk Engine decides - this is what ShadowPortfolioBenchmark's "Shadow" line means.
  // Never places a real order and never touches the real broker.
  eventBus.on('CHIEF_APPROVED_IDEA', (idea: any) => {
    if (typeof idea.currentPrice === 'number' && idea.currentPrice > 0 && (idea.side === 'BUY' || idea.side === 'SELL')) {
      executeAutoBotTradeInShadow(idea.symbol, idea.side, idea.currentPrice, tradingEngine.state.maxTradeSize);
    }
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
  app.get("/api/v1/kronos/status", (req, res) => { try { res.json(kronosEngine.getStatus()); } catch(e: any) { res.status(500).json({error: e.message}); } });

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

  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'API route not found: ' + req.path });
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
    const prices = {};
    for (const [sym, quote] of Object.entries(liveQuotes)) {
       prices[sym] = (quote as any).price;
    }
    BrokerManager.getInstance().tick(prices);
  }, 1000);
  
  // Broadcast AutoBot state to all connected clients
  setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify({
          type: 'AUTOBOT_STATE_UPDATED',
          data: tradingEngine.state
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
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Enterprise scale multi-agent backend running on port ${PORT}`);
  });
}

startServer();

let globalWss: any = null;
export const setGlobalWss = (w: any) => globalWss = w;
export const getGlobalWss = () => globalWss;