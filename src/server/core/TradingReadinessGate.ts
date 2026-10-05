/**
 * Trading Readiness Gate - pure observability, additive.
 *
 * Zero-Trade Forensic Audit follow-up: "process alive" was repeatedly mistaken for "trading
 * pipeline healthy" (CLI/health endpoints reported OK while the AI layer was ~95% failed). This
 * module makes that distinction explicit and structural: Process / Database / Market Data /
 * Broker / Technical Engine / Quant Engine / AI Provider Layer are each reported independently,
 * and only when every applicable one is ready does `tradingReady` become true.
 *
 * This is NOT evaluateLiveReadiness() and does not replace it - that function (liveReadinessEngine.ts)
 * remains the sole authority on LIVE real-money arming, with its own protected 28-gate contract.
 * `tradingReady` here answers a different, narrower question: "is the idea-generation/consensus
 * pipeline itself currently well-formed" - it never arms LIVE, never toggles Autobot, never places
 * or blocks an order by itself. Existing gates (TRADING_ENABLED, autobot_enabled, the 24 RiskEngine
 * gates, evaluateLiveReadiness()) are completely unchanged by this file's existence.
 */
import { argusRuntime } from './ArgusRuntime';
import { getPipelineAgentSnapshot } from './pipelineAgentSnapshot';
import { getAIProviderHealthSnapshot, type AIProviderHealthRecord } from '../ai/AIProviderHealthCheck';
import { db } from '../db';
import * as schema from '../db/schema';
import { desc } from 'drizzle-orm';
import { getMarketDataReadiness } from './marketDataReadiness';
import { classifyMarketSession } from '../replay/marketSession';
import { TRADING_TIMEZONE } from './TradingCalendar';

export interface ReadinessNode {
  id: string;
  label: string;
  ready: boolean;
  /** True when this node is intentionally not applicable right now (e.g. Quant disabled by
   *  config) - counted as passing for tradingReady, distinct from a real failure. */
  notApplicable?: boolean;
  detail: string;
  children?: ReadinessNode[];
}

export interface TradingReadinessSnapshot {
  generatedAt: string;
  nodes: ReadinessNode[];
  tradingReady: boolean;
  reasons: string[];
}

async function checkDatabase(): Promise<{ ready: boolean; detail: string }> {
  try {
    await db.select().from(schema.settings).limit(1);
    return { ready: true, detail: 'query ok' };
  } catch (e: unknown) {
    return { ready: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Capital-profile consistency (2026-10-04 synthetic-framework forensic audit, blind spot #1).
 * The $2K-intended vs $100K-runtime incident class had zero tripwire: nothing asserted the
 * budget RiskEngine actually enforces (settings.budget, gate 23's own source) matches the
 * operator's declared intent. This node closes that gap as pure observability:
 * - settings.budget missing/not-positive -> NOT READY (fail closed; gate 23 refuses every BUY
 *   anyway, so the pipeline is not well-formed for trading)
 * - ARGUS_EXPECTED_BUDGET unset -> notApplicable (intent unknown, cannot verify)
 * - mismatch -> NOT READY with an explicit BUDGET_MISMATCH reason
 * It never changes a threshold, never blocks an order itself, never touches RiskEngine/OMS.
 */
async function checkCapitalProfile(): Promise<ReadinessNode> {
  const base = { id: 'capitalProfile', label: 'Capital Profile' } as const;
  let budget: number | null = null;
  try {
    const rows = (await db.select().from(schema.settings).limit(1)) as Array<{ budget?: unknown }>;
    const n = Number(rows?.[0]?.budget);
    budget = Number.isFinite(n) && n > 0 ? n : null;
  } catch (e: unknown) {
    return { ...base, ready: false, detail: `settings.budget unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (budget === null) {
    return {
      ...base,
      ready: false,
      detail: 'settings.budget missing or not positive — RiskEngine gate 23 will refuse every BUY; set the Argus allocation before trading',
    };
  }
  const expectedRaw = process.env.ARGUS_EXPECTED_BUDGET;
  if (expectedRaw === undefined || expectedRaw === '') {
    return {
      ...base,
      ready: true,
      notApplicable: true,
      detail: `settings.budget=$${budget.toLocaleString('en-US')} (no ARGUS_EXPECTED_BUDGET declared — operator intent unverified)`,
    };
  }
  const expected = Number(expectedRaw);
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ...base, ready: false, detail: `ARGUS_EXPECTED_BUDGET=${expectedRaw} is not a positive number` };
  }
  if (budget !== expected) {
    return {
      ...base,
      ready: false,
      detail: `BUDGET_MISMATCH: settings.budget=$${budget.toLocaleString('en-US')} but ARGUS_EXPECTED_BUDGET=$${expected.toLocaleString('en-US')} — resolve the intended allocation before trading`,
    };
  }
  return { ...base, ready: true, detail: `settings.budget=$${budget.toLocaleString('en-US')} matches declared intent` };
}

function aiProviderLayerNode(providers: AIProviderHealthRecord[]): ReadinessNode {
  const children: ReadinessNode[] = providers.map((p) => ({
    id: p.providerId,
    label: p.providerName,
    ready: p.status === 'HEALTHY',
    detail: p.status,
  }));
  const healthyCount = providers.filter((p) => p.status === 'HEALTHY').length;
  return {
    id: 'aiProviderLayer',
    label: 'AI Provider Layer',
    ready: healthyCount > 0,
    detail: providers.length === 0
      ? 'no providers registered'
      : `${healthyCount}/${providers.length} healthy`,
    children,
  };
}

export async function getTradingReadinessSnapshot(): Promise<TradingReadinessSnapshot> {
  const reasons: string[] = [];
  const nodes: ReadinessNode[] = [];

  let health: ReturnType<typeof argusRuntime.health> | null = null;
  try {
    health = argusRuntime.health();
  } catch {
    health = null;
  }
  nodes.push({
    id: 'process',
    label: 'Process',
    ready: health?.ok === true,
    detail: health?.ok ? `pid ${health.pid}, uptime ${Math.round(health.uptimeMs / 1000)}s` : 'core not booted / health check failed',
  });
  if (!health?.ok) reasons.push('Process not booted');

  const dbCheck = await checkDatabase();
  nodes.push({ id: 'database', label: 'Database', ready: dbCheck.ready, detail: dbCheck.detail });
  if (!dbCheck.ready) reasons.push('Database unreachable');

  const capitalNode = await checkCapitalProfile();
  nodes.push(capitalNode);
  if (!capitalNode.ready && !capitalNode.notApplicable) reasons.push(`Capital profile: ${capitalNode.detail}`);

  let marketData = { ready: false, detail: 'quote evidence unavailable' };
  try { marketData = getMarketDataReadiness(); } catch { /* fail closed */ }
  nodes.push({
    id: 'marketData',
    label: 'Market Data',
    ready: marketData.ready,
    detail: marketData.detail,
  });
  if (!marketData.ready) reasons.push(`Market data not ready: ${marketData.detail}`);

  let brokerCheck = { ready: false, detail: 'no active broker / connection evidence unavailable' };
  if (health?.brokerId) {
    try { brokerCheck = await argusRuntime.brokerReadiness(); } catch { /* fail closed */ }
  }
  nodes.push({ id: 'broker', label: 'Broker', ready: brokerCheck.ready, detail: brokerCheck.detail });
  if (!brokerCheck.ready) reasons.push(`Broker unavailable: ${brokerCheck.detail}`);

  let pipeline: ReturnType<typeof getPipelineAgentSnapshot> | null = null;
  try {
    pipeline = getPipelineAgentSnapshot();
  } catch {
    pipeline = null;
  }
  const entryReady = pipeline?.liveIdeaGenerationEnabled === true;
  // Real observability gap found 2026-10-05 (morning paper-session audit): this detail string was
  // the single most-checked readiness surface, and for a non-enabled tradingState it said only
  // "trading state TRADING_PAUSED" - no reason, no actor, no timestamp. A real auto-pause
  // (PortfolioReconciliation, 09:10:58 ET) sat unnoticed for the rest of that morning because
  // nothing here distinguished "paused, reason unknown" from "paused, here's exactly why and when".
  // kill_switch_events is the existing, durable, already-authoritative audit trail for every
  // transition - this surfaces its own latest row rather than inventing a second source of truth.
  let pauseContext = '';
  if (pipeline && pipeline.tradingState !== 'TRADING_ENABLED') {
    try {
      const [lastTransition] = await db.select().from(schema.killSwitchEvents)
        .orderBy(desc(schema.killSwitchEvents.id)).limit(1);
      if (lastTransition && lastTransition.toState === pipeline.tradingState) {
        pauseContext = ` [${lastTransition.actor} @ ${lastTransition.createdAt}: ${lastTransition.reason}]`;
      }
    } catch { /* best-effort enrichment only - never block readiness evaluation on this */ }
  }
  const entryDetail = pipeline === null ? 'entry gate evidence unavailable'
    : pipeline.interruptedSessionHold ? 'unclean restart: awaiting a real reconciliation match'
    : pipeline.tradingState !== 'TRADING_ENABLED' ? `trading state ${pipeline.tradingState}${pauseContext}`
    : !pipeline.autobotEnabled ? 'Autobot disabled'
    : pipeline.forensicCheckpointBuyLock?.locked ? 'first-fill forensic checkpoint holds new entries'
    : entryReady ? 'entry generation enabled; consensus and risk checks still required'
    : 'entry generation held by campaign or another entry gate';
  nodes.push({ id: 'entryGeneration', label: 'Entry Generation', ready: entryReady, detail: entryDetail });
  if (!entryReady) reasons.push(`Entry generation blocked: ${entryDetail}`);
  // Pre-market/market-open readiness fix (2026-08-25): IDLE_WAITING_FOR_MARKET_DATA is the
  // documented, expected state outside the regular session before ~50 ticks have arrived (CLAUDE.md "Technical after ~50
  // ticks") or before Alpaca's clock opens - it is not a failure, exactly as `market_hours`
  // (RiskEngine gate 12) is *expected* to fail pre-open per the pre-market checklist. Before this
  // fix, `tradingReady` was false on every single pre-market check with reason "Technical engine
  // not running", even though nothing was actually broken - confirmed live via ./argus
  // session-report during PRE_MARKET. Treated the same way QuantEngine already treats
  // "disabled by config": counted toward tradingReady, distinctly labeled, never silently folded
  // into "RUNNING". During the regular session a waiting agent is not ready; feed-level
  // quote evidence above independently prevents an empty connected socket from passing.
  const technical = pipeline?.togglable.find((a) => a.id === 'TechnicalAgent');
  const outsideRegularSession = classifyMarketSession(Date.now(), TRADING_TIMEZONE, true) !== 'REGULAR';
  const technicalWaitingForData = technical?.healthLabel === 'IDLE_WAITING_FOR_MARKET_DATA';
  const technicalIdleExpected = technicalWaitingForData && outsideRegularSession;
  const technicalReady = technical?.healthy === true || technicalIdleExpected;
  nodes.push({
    id: 'technicalEngine',
    label: 'Technical Engine',
    ready: technicalReady,
    notApplicable: technicalIdleExpected,
    detail: technical?.healthLabel ?? 'UNKNOWN',
  });
  if (!technicalReady) reasons.push('Technical engine not running');

  const quant = pipeline?.togglable.find((a) => a.id === 'QuantEngine');
  // Quant is additive/default-off (CLAUDE.md) - not being enabled is not a failure.
  const quantApplicable = quant?.available === true;
  const quantWaitingForData = quant?.healthLabel === 'IDLE_WAITING_FOR_MARKET_DATA';
  const quantIdleExpected = quantWaitingForData && outsideRegularSession;
  const quantReady = !quantApplicable || quant?.healthy === true || quantIdleExpected;
  nodes.push({
    id: 'quantEngine',
    label: 'Quant Engine',
    ready: quantReady,
    notApplicable: !quantApplicable || quantIdleExpected,
    detail: !quantApplicable ? 'disabled by config (QUANT_ENGINE_ENABLED not set - optional)' : (quant?.healthLabel ?? 'UNKNOWN'),
  });
  if (quantApplicable && !quantReady) reasons.push('Quant engine enabled but not running');

  let aiProviders: AIProviderHealthRecord[] = [];
  try {
    aiProviders = await getAIProviderHealthSnapshot();
  } catch {
    aiProviders = [];
  }
  const aiNode = aiProviderLayerNode(aiProviders);
  nodes.push(aiNode);
  if (!aiNode.ready) reasons.push('No AI provider is currently authenticating (consensus debate/fundamental/macro/news quality degraded)');

  const tradingReady = nodes.every((n) => n.ready || n.notApplicable === true);

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    tradingReady,
    reasons,
  };
}

/** Plain-text tree, matching the ASCII shape used in operator discussion of this feature. */
export function renderTradingReadinessTree(snapshot: TradingReadinessSnapshot): string {
  const mark = (n: ReadinessNode) => (n.notApplicable ? '➖' : n.ready ? '✅' : '❌');
  const lines: string[] = ['ARGUS'];
  const top = snapshot.nodes.filter((n) => n.id !== 'aiProviderLayer');
  for (const n of top) {
    lines.push(`├── ${n.label.padEnd(22)} ${mark(n)}${!n.ready && !n.notApplicable ? ` ${n.detail}` : ''}`);
  }
  const ai = snapshot.nodes.find((n) => n.id === 'aiProviderLayer');
  if (ai) {
    lines.push(`├── ${ai.label.padEnd(22)} ${mark(ai)}`);
    const children = ai.children ?? [];
    children.forEach((c, i) => {
      const branch = i === children.length - 1 ? '└──' : '├──';
      lines.push(`│   ${branch} ${c.label.padEnd(18)} ${mark(c)}${c.ready ? '' : ` ${c.detail}`}`);
    });
  }
  lines.push('');
  lines.push(`└── ${'TRADING READY'.padEnd(22)} ${snapshot.tradingReady ? '✅' : '❌'}`);
  return lines.join('\n');
}
