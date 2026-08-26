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
 * Post-remediation-audit fix: this file previously imported BrokerManager directly
 * (architecture.protection.test.ts's BrokerManager allowlist correctly caught this as an
 * unreviewed import). It only ever needed a read-only "is a broker active" signal, which
 * ArgusRuntime.health() (an already-allowlisted BrokerManager consumer) already exposes as
 * `brokerId` - reusing that removes the need for a second direct importer entirely rather than
 * expanding the allowlist for a diagnostic-only read.
 */
function checkBroker(brokerId: string | null): { ready: boolean; detail: string } {
  if (!brokerId) return { ready: false, detail: 'no active broker' };
  return { ready: true, detail: brokerId };
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

  const marketDataConnected = health?.marketDataConnected === true;
  nodes.push({
    id: 'marketData',
    label: 'Market Data',
    ready: marketDataConnected,
    detail: marketDataConnected ? 'connected' : 'disconnected',
  });
  if (!marketDataConnected) reasons.push('Market data disconnected');

  const brokerCheck = checkBroker(health?.brokerId ?? null);
  nodes.push({ id: 'broker', label: 'Broker', ready: brokerCheck.ready, detail: brokerCheck.detail });
  if (!brokerCheck.ready) reasons.push('Broker unavailable');

  let pipeline: ReturnType<typeof getPipelineAgentSnapshot> | null = null;
  try {
    pipeline = getPipelineAgentSnapshot();
  } catch {
    pipeline = null;
  }
  // Pre-market/market-open readiness fix (2026-08-25): IDLE_WAITING_FOR_MARKET_DATA is the
  // documented, expected state before ~50 ticks have arrived (CLAUDE.md "Technical after ~50
  // ticks") or before Alpaca's clock opens - it is not a failure, exactly as `market_hours`
  // (RiskEngine gate 12) is *expected* to fail pre-open per the pre-market checklist. Before this
  // fix, `tradingReady` was false on every single pre-market check with reason "Technical engine
  // not running", even though nothing was actually broken - confirmed live via ./argus
  // session-report during PRE_MARKET. Treated the same way QuantEngine already treats
  // "disabled by config": counted toward tradingReady, distinctly labeled, never silently folded
  // into "RUNNING".
  const technical = pipeline?.togglable.find((a) => a.id === 'TechnicalAgent');
  const technicalWaitingForData = technical?.healthLabel === 'IDLE_WAITING_FOR_MARKET_DATA';
  const technicalReady = technical?.healthy === true || technicalWaitingForData;
  nodes.push({
    id: 'technicalEngine',
    label: 'Technical Engine',
    ready: technicalReady,
    notApplicable: technicalWaitingForData,
    detail: technical?.healthLabel ?? 'UNKNOWN',
  });
  if (!technicalReady) reasons.push('Technical engine not running');

  const quant = pipeline?.togglable.find((a) => a.id === 'QuantEngine');
  // Quant is additive/default-off (CLAUDE.md) - not being enabled is not a failure.
  const quantApplicable = quant?.available === true;
  const quantWaitingForData = quant?.healthLabel === 'IDLE_WAITING_FOR_MARKET_DATA';
  const quantReady = !quantApplicable || quant?.healthy === true || quantWaitingForData;
  nodes.push({
    id: 'quantEngine',
    label: 'Quant Engine',
    ready: quantReady,
    notApplicable: !quantApplicable || quantWaitingForData,
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
    lines.push(`├── ${n.label.padEnd(22)} ${mark(n)}`);
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
