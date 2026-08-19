/**
 * Architecture-protection regression suite (ARGUS_ARCHITECTURE_PROTECTION.md).
 *
 * These tests do not exercise runtime behavior - they statically assert that the protected
 * execution spine (ChiefTraderAgent -> RiskEngine -> OMS -> BrokerManager) has exactly one
 * caller for each of its entry points, and that the extension zone (src/server/multiAsset/,
 * src/server/continuous/) never reaches around it. The goal is that a future change - human or
 * AI-authored - that adds a second broker-order path, a second CHIEF_APPROVED_IDEA source, or a
 * direct BrokerManager/OMS import from a discovery/scanner module fails CI immediately instead of
 * being discovered later as a live incident.
 *
 * Extends (does not duplicate) src/server/research/phase21.invariants.test.ts, which already
 * asserts OMS is the sole `.placeOrder(` caller. This suite covers the newer extension-zone
 * modules and the other protected entry points that phase21's suite does not check.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd());

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.venv' || name === 'archive') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function rel(f: string): string {
  return relative(ROOT, f).replace(/\\/g, '/');
}

const SERVER_TS_FILES = walkFiles(join(ROOT, 'src', 'server'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('Architecture protection: BrokerManager access is allowlisted', () => {
  // Reviewed set as of 2026-08-18. A new entry here is a real architectural decision, not a
  // drive-by import - adding a file to this list should come with a reason in the PR/commit,
  // not just to make this test pass.
  const ALLOWED_BROKER_MANAGER_IMPORTERS = new Set([
    'src/server/core/IntegrityValidator.ts',
    'src/server/core/wsInitialSnapshot.ts',
    'src/server/diagnostics/DiagnosticService.ts',
    'src/server/engines/RiskEngine.ts',
    'src/server/engines/TradingEngine.ts',
    'src/server/routes/integrationRoutes.ts',
    'src/server/routes/systemRoutes.ts',
    'src/server/routes/v2System.ts',
    'src/server/services/MarketDataCrossChecker.ts',
    'src/server/services/OrderManagement.ts',
    'src/server/services/PortfolioRebalance.ts',
    'src/server/services/PortfolioReconciliation.ts',
  ]);

  it('no file outside the reviewed allowlist imports BrokerManager', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (path.startsWith('src/server/core/BrokerManager') || path.startsWith('src/server/brokers/')) continue;
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*BrokerManager['"]/.test(text) || /BrokerManager\.getInstance\(/.test(text)) {
        if (!ALLOWED_BROKER_MANAGER_IMPORTERS.has(path)) hits.push(path);
      }
    }
    expect(hits).toEqual([]);
  });

  it('discovery/multi-asset extension-zone modules specifically never import or call BrokerManager (comments documenting the absence don\'t count)', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (!path.startsWith('src/server/multiAsset/') && !path.startsWith('src/server/continuous/')) continue;
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*BrokerManager['"]/.test(text) || /BrokerManager\.getInstance\(/.test(text)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});

describe('Architecture protection: extension-zone modules cannot reach the spine directly', () => {
  const EXTENSION_ZONE_DIRS = ['src/server/multiAsset/', 'src/server/continuous/'];

  it('multiAsset/ and continuous/ never import OrderManagement or RiskEngine', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (!EXTENSION_ZONE_DIRS.some((d) => path.startsWith(d))) continue;
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*OrderManagement['"]/.test(text)) hits.push(`${path}: imports OrderManagement`);
      if (/from ['"][^'"]*\/RiskEngine['"]/.test(text)) hits.push(`${path}: imports RiskEngine`);
    }
    expect(hits).toEqual([]);
  });

  it('multiAsset/ and continuous/ never call .placeOrder( directly', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (!EXTENSION_ZONE_DIRS.some((d) => path.startsWith(d))) continue;
      const text = readFileSync(f, 'utf8');
      if (text.includes('.placeOrder(')) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it('OpportunityDiscovery never emits TRADE_IDEA_GENERATED (discovery only expands the watchlist, it does not propose trades)', () => {
    const text = readFileSync(join(ROOT, 'src/server/continuous/OpportunityDiscovery.ts'), 'utf8');
    expect(text).not.toMatch(/emitTradeIdea\(/);
    expect(text).not.toMatch(/\.emit\(\s*(EVENTS\.TRADE_IDEA_GENERATED|['"]TRADE_IDEA_GENERATED['"])/);
  });

  it('ExitIntelligenceEngine.ts (ARGUS_EXIT_INTELLIGENCE_PLAN.md) never imports EventBus, RiskEngine, OrderManagement, or BrokerManager, and never emits or places anything itself - it is a pure evaluation function PortfolioMonitor consults and acts on', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/ExitIntelligenceEngine.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*EventBus['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/emitTradeIdea\(/);
  });
});

describe('Architecture protection: CHIEF_APPROVED_IDEA has exactly one authorized emitter set', () => {
  // Every file allowed to emit this event, and why. A new emitter is a new order-approval path
  // and must be added deliberately, not silently.
  const ALLOWED_EMITTERS: Record<string, string> = {
    'src/server/services/ChiefTraderAgent.ts': 'the real consensus engine',
    'src/server/services/PipelineFlatten.ts': 'documented liquidate override, still requires RiskEngine/OMS',
    'src/server/core/telemetryPulse.ts': 'synthetic UI-only demo pulse, explicitly RiskAgent-ignored',
    'src/server/routes/v2System.ts': 'documented human manual-override route, still requires RiskEngine/OMS',
    'src/server/core/EventBus.ts': 'EventBus internal replay/rebroadcast plumbing',
  };

  it('no file outside the reviewed allowlist emits CHIEF_APPROVED_IDEA', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      const text = readFileSync(f, 'utf8');
      const emits = /\.emit\(\s*(EVENTS\.CHIEF_APPROVED_IDEA|['"]CHIEF_APPROVED_IDEA['"])/.test(text);
      if (emits && !(path in ALLOWED_EMITTERS)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it('the manual-override route requires RiskEngine/OMS afterward (never places an order itself)', () => {
    const text = readFileSync(join(ROOT, 'src/server/routes/v2System.ts'), 'utf8');
    const idx = text.indexOf("eventBus.emit('CHIEF_APPROVED_IDEA'");
    expect(idx).toBeGreaterThan(0);
    const before = text.slice(Math.max(0, idx - 1200), idx);
    expect(before).not.toMatch(/\.placeOrder\(/);
    expect(before).not.toMatch(/BrokerManager\.getInstance/);
  });
});

describe('Architecture protection: trading_state is written from exactly one place', () => {
  it('only TradingEngine.ts writes settings.tradingState', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (path === 'src/server/engines/TradingEngine.ts') continue;
      const text = readFileSync(f, 'utf8');
      if (/\.set\(\s*\{\s*tradingState:/.test(text)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});
