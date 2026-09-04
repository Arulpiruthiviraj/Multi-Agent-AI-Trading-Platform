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
    'src/server/core/ArgusCoreBoot.ts',
    'src/server/core/ArgusRuntime.ts',
    'src/server/core/wsInitialSnapshot.ts',
    'src/server/diagnostics/DiagnosticService.ts',
    'src/server/engines/RiskEngine.ts',
    'src/server/engines/TradingEngine.ts',
    'src/server/routes/integrationRoutes.ts',
    'src/server/routes/systemRoutes.ts',
    'src/server/routes/v2System.ts',
    // Operator broker switch + runtime health reporting (read/switch only — OMS remains sole placeOrder).
    'src/server/routes/configRoutes.ts',
    'src/server/routes/v2Runtime.ts',
    'src/server/services/MarketDataCrossChecker.ts',
    'src/server/services/OrderManagement.ts',
    'src/server/services/PortfolioRebalance.ts',
    'src/server/services/PortfolioReconciliation.ts',
    // Read-only local↔broker portfolio compare after first organic PAPER fill (no placeOrder).
    'src/server/services/FirstFillForensicCheckpoint.ts',
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

  it('only OpportunityScreener in continuous/ may emitTradeIdea (still one vote; never CHIEF_APPROVED_IDEA)', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (!path.startsWith('src/server/continuous/')) continue;
      const text = readFileSync(f, 'utf8');
      if (!/emitTradeIdea\(/.test(text)) continue;
      if (path !== 'src/server/continuous/OpportunityScreener.ts') hits.push(path);
    }
    expect(hits).toEqual([]);
    const screener = readFileSync(join(ROOT, 'src/server/continuous/OpportunityScreener.ts'), 'utf8');
    expect(screener).toMatch(/emitTradeIdea\(/);
    expect(screener).not.toMatch(/\.placeOrder\(/);
  });

  it('continuous/ never emits CHIEF_APPROVED_IDEA or imports ChiefTrader (ideas enter via emitTradeIdea only)', () => {
    const hits: string[] = [];
    for (const f of SERVER_TS_FILES) {
      const path = rel(f);
      if (!path.startsWith('src/server/continuous/')) continue;
      const text = readFileSync(f, 'utf8');
      if (/\.emit\(\s*(EVENTS\.CHIEF_APPROVED_IDEA|['"]CHIEF_APPROVED_IDEA['"])/.test(text)) {
        hits.push(`${path}: emits CHIEF_APPROVED_IDEA`);
      }
      if (/from ['"][^'"]*ChiefTraderAgent['"]/.test(text)) hits.push(`${path}: imports ChiefTraderAgent`);
    }
    expect(hits).toEqual([]);
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

  it('CampaignTracker.ts never imports RiskEngine/OMS/BrokerManager or calls placeOrder (BUY soft-lock only via ideaGenerationGate)', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/CampaignTracker.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/CHIEF_APPROVED_IDEA/);
    // Soft-lock is in-memory only — must never write tradingState / kill-switch transitions.
    expect(text).not.toMatch(/tradingState\s*=/);
    expect(text).not.toMatch(/setTradingState/);
    expect(text).toMatch(/campaignWatchlistBoostWorker/);
  });

  it('CampaignWatchlistBoost never placeOrder / RiskEngine / OMS / emitTradeIdea', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/CampaignWatchlistBoost.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/emitTradeIdea\s*\(/);
  });

  it('CampaignOpeningSurge never placeOrder / RiskEngine / OMS / emitTradeIdea', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/CampaignOpeningSurge.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/emitTradeIdea\s*\(/);
  });

  it('FirstFillForensicCheckpoint.ts never calls placeOrder or invents a second kill switch (Autobot toggle + BUY soft-lock only)', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/FirstFillForensicCheckpoint.ts'), 'utf8');
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/CHIEF_APPROVED_IDEA/);
    expect(text).not.toMatch(/setTradingState/);
    expect(text).not.toMatch(/EMERGENCY_STOP/);
    // Fail path must use existing Autobot toggle + forensic buy lock, not a parallel order path.
    expect(text).toMatch(/toggle\(\{\s*enabled:\s*false\s*\}\)/);
    expect(text).toMatch(/setForensicCheckpointBuyLock/);
    // BrokerManager is allowlisted for read-only portfolio(); must not place orders.
    expect(text).toMatch(/BrokerManager/);
    const boot = readFileSync(join(ROOT, 'src/server/core/ArgusCoreBoot.ts'), 'utf8');
    expect(boot).toMatch(/firstFillForensicCheckpoint\.start\(/);
  });
});

describe('Architecture protection: CHIEF_APPROVED_IDEA has exactly one authorized emitter set', () => {
  // Every file allowed to emit this event, and why. A new emitter is a new order-approval path
  // and must be added deliberately, not silently.
  const ALLOWED_EMITTERS: Record<string, string> = {
    'src/server/services/ChiefTraderAgent.ts': 'the real consensus engine',
    'src/server/services/PipelineFlatten.ts': 'documented liquidate override, still requires RiskEngine/OMS',
    'src/server/core/telemetryPulse.ts': 'synthetic UI-only demo pulse, explicitly RiskAgent-ignored',
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

  it('the manual-override route delegates to real ChiefTrader consensus and never emits CHIEF_APPROVED_IDEA or places an order itself', () => {
    // Real refactor (post 2026-08-18): the route no longer emits CHIEF_APPROVED_IDEA directly -
    // it triggers on-demand agent co-eval (runManualTradeCoEvaluation) and waits for
    // ChiefTraderAgent's own real consensus outcome, same floors as the autonomous path. See
    // manualTradeCoEvaluation.ts and v2System.ts's own comment on this route.
    const text = readFileSync(join(ROOT, 'src/server/routes/v2System.ts'), 'utf8');
    const idx = text.indexOf("v2Router.post('/trading/execute-override'");
    expect(idx).toBeGreaterThan(0);
    const routeSlice = text.slice(idx, idx + 2000);
    expect(routeSlice).toMatch(/runManualTradeCoEvaluation/);
    expect(routeSlice).not.toMatch(/eventBus\.emit\(\s*(EVENTS\.CHIEF_APPROVED_IDEA|['"]CHIEF_APPROVED_IDEA['"])/);
    expect(routeSlice).not.toMatch(/\.placeOrder\(/);
    expect(routeSlice).not.toMatch(/BrokerManager\.getInstance/);

    const coEvalText = readFileSync(join(ROOT, 'src/server/services/manualTradeCoEvaluation.ts'), 'utf8');
    expect(coEvalText).not.toMatch(/\.placeOrder\(/);
    expect(coEvalText).not.toMatch(/BrokerManager\.getInstance/);
    // Real consensus floors, not a manual-path shortcut - same config keys the autonomous path uses.
    expect(coEvalText).toMatch(/tradingSafety\.consensusApprovalThreshold/);
    expect(coEvalText).toMatch(/tradingSafety\.minIndependentAgreeingAgents/);
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

describe('Architecture protection: incident-remediation contracts', () => {
  it('consensus bars remain 0.75 and minIndependentAgreeingAgents 2 in reviewed JSON', () => {
    const safety = readFileSync(join(ROOT, 'config/tradingSafety.json'), 'utf8');
    expect(safety).toMatch(/"consensusApprovalThreshold":\s*0\.75/);
    expect(safety).toMatch(/"minIndependentAgreeingAgents":\s*2/);
  });

  it('session recovery never places orders, never emits CHIEF_APPROVED_IDEA, and never auto-unpauses', () => {
    const text = readFileSync(join(ROOT, 'src/server/core/sessionRecovery.ts'), 'utf8');
    expect(text).not.toMatch(/placeOrder\(/);
    expect(text).not.toMatch(/CHIEF_APPROVED_IDEA/);
    expect(text).not.toMatch(/setTradingState/);
    expect(text).toMatch(/RECONCILIATION_MATCH/);
  });

  it('PortfolioReconciliation starts at core boot and is not stopped when Autobot turns off', () => {
    // CODE contract (interrupted-session hold clear without Autobot):
    // - ArgusCoreBoot starts recon independent of Autobot (like MarketDataWorker).
    // - SystemBootstrap.start may re-start (idempotent); SystemBootstrap.stop must NOT stop recon.
    // - Only gracefulShutdown drain stops recon (process exit).
    const boot = readFileSync(join(ROOT, 'src/server/core/ArgusCoreBoot.ts'), 'utf8');
    expect(boot).toMatch(/portfolioReconciliationWorker\.start\(/);
    expect(boot).toMatch(/independent of Autobot/);
    expect(boot).toMatch(/RECONCILIATION_MATCH releases interrupted-session entry hold/);

    const bootstrap = readFileSync(join(ROOT, 'src/server/core/SystemBootstrap.ts'), 'utf8');
    expect(bootstrap).toMatch(/portfolioReconciliationWorker\.start\(/);
    expect(bootstrap).toMatch(/Recon stays up when Autobot is off/);
    const stopMethod = bootstrap.match(/stop\(\)\s*\{[\s\S]*?\n\s*\}/);
    expect(stopMethod?.[0]).toBeTruthy();
    // Executable Autobot-off path must not stop recon (comments may mention drain stop).
    expect(stopMethod![0]).not.toMatch(/^\s*portfolioReconciliationWorker\.stop\(\);/m);

    const drain = readFileSync(join(ROOT, 'src/server/core/gracefulShutdown.ts'), 'utf8');
    expect(drain).toMatch(/portfolioReconciliationWorker\.stop\(/);
  });

  it('MarketDataWorker tick emission is not gated on the interrupted-session entry hold', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/MarketDataWorker.ts'), 'utf8');
    expect(text).toMatch(/isAutobotTradingEnabled/);
    expect(text).not.toMatch(/allowsNewEntryIdeas/);
    expect(text).not.toMatch(/isLiveIdeaGenerationEnabled/);
  });

  it('PortfolioMonitor SELL path does not import the entry-idea gate', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/PortfolioMonitor.ts'), 'utf8');
    expect(text).not.toMatch(/ideaGenerationGate/);
    expect(text).not.toMatch(/sessionRecovery/);
    expect(text).toMatch(/emitTradeIdea/);
  });

  it('architecture contract and AI change-rule files exist', () => {
    const contract = readFileSync(join(ROOT, 'ARGUS_ARCHITECTURE_CONTRACT.md'), 'utf8');
    const rules = readFileSync(join(ROOT, 'ARGUS_AI_CHANGE_RULES.md'), 'utf8');
    expect(contract).toMatch(/Protected execution spine/);
    expect(contract).toMatch(/PAPER_TRADING_ONLY/);
    expect(rules).toMatch(/never bypass/);
  });

  it('engine daemon entry and CLI cannot become a second trading brain', () => {
    const engine = readFileSync(join(ROOT, 'scripts/argus-engine.ts'), 'utf8');
    const cli = readFileSync(join(ROOT, 'scripts/argus-cli.ts'), 'utf8');
    expect(engine).not.toMatch(/from ['"]vite['"]/);
    expect(cli).not.toMatch(/from ['"].*OrderManagement/);
    expect(cli).not.toMatch(/from ['"].*RiskEngine/);
    expect(cli).not.toMatch(/from ['"].*BrokerManager/);
    const core = readFileSync(join(ROOT, 'src/server/core/ArgusCoreBoot.ts'), 'utf8');
    expect(core).not.toMatch(/from ['"]vite['"]/);
  });

  it('ResearchTriggerEngine.ts never imports RiskEngine/OMS/BrokerManager/ChiefTraderAgent, never calls placeOrder, never emits a trade idea or mutates strategy lifecycle/registry', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/ResearchTriggerEngine.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*ChiefTraderAgent['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/emitTradeIdea\(/);
    expect(text).not.toMatch(/CHIEF_APPROVED_IDEA/);
    expect(text).not.toMatch(/setTradingState/);
    expect(text).not.toMatch(/strategyEngineActiveIds|StrategyRegistry/);
    // Reuses the existing Phase 3.1 async architecture rather than a second execution mechanism.
    expect(text).toMatch(/beginStrategyGraduationRun/);
  });

  it('KronosDissimilarityGate.ts (model-trust/OOD gate, 2026-09-04) never imports RiskEngine/OMS/BrokerManager/ChiefTraderAgent/EventBus and never places or influences an order itself - it is a pure statistics module KronosForecastAgent consults', () => {
    const text = readFileSync(join(ROOT, 'src/server/quant/KronosDissimilarityGate.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*\/RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*ChiefTraderAgent['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*\/EventBus['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
    expect(text).not.toMatch(/emitTradeIdea\(/);
    expect(text).not.toMatch(/CHIEF_APPROVED_IDEA/);
  });

  it("a browser WebSocket client disconnecting cannot reach TradingEngine/RiskEngine/OMS/BrokerManager", () => {
    // Extracts the exact ws.on('close', ...) handler body from server.ts and proves it only ever
    // does listener cleanup (eventBus.off) - never anything that could pause/resume trading,
    // touch risk, or place/cancel an order. A WS client disconnecting must be a pure one-way
    // observer leaving, not an input the trading spine reacts to.
    const text = readFileSync(join(ROOT, 'server.ts'), 'utf8');
    const closeHandlerMatch = text.match(/ws\.on\('close',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
    expect(closeHandlerMatch, "expected to find server.ts's ws.on('close', ...) handler").toBeTruthy();
    const closeHandlerBody = closeHandlerMatch![1];
    expect(closeHandlerBody).not.toMatch(/tradingEngine\.(toggle|setTradingState)/);
    expect(closeHandlerBody).not.toMatch(/riskEngine|RiskEngine/);
    expect(closeHandlerBody).not.toMatch(/placeOrder|BrokerManager/);
    expect(closeHandlerBody).not.toMatch(/eventBus\.emit/);
    expect(closeHandlerBody).toMatch(/eventBus\.off/);
  });
});
