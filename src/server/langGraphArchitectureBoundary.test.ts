/**
 * Architecture-protection regression suite for the LangGraph research service
 * (docs/architecture/ARGUS_ARCHITECTURE.md (LangGraph Research Service section)). Mirrors architecture.protection.test.ts's own
 * static-check pattern exactly, applied to the new integration surface this session added:
 *
 *   - src/server/services/LangGraphResearchService.ts (Node HTTP client)
 *   - src/server/services/ResearchAgentRunner.ts (Node persistence orchestration)
 *   - scripts/lib/langGraphLauncher.ts (companion process launcher)
 *   - langgraph-research/ (the isolated Python process itself)
 *
 * The goal is the same as the existing suite: a future change that adds a second broker-order
 * path, a second CHIEF_APPROVED_IDEA source, or a direct RiskEngine/OMS/BrokerManager/
 * ChiefTraderAgent import from any of the above fails CI immediately. The Python side already has
 * its own equivalent check (langgraph-research/tests/test_safety_boundary.py) - this file is the
 * Node-side, cross-language belt-and-suspenders version of the same guarantee.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd());

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.venv' || name === '__pycache__' || name === '.pytest_cache') continue;
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

const NODE_SIDE_FILES = [
  join(ROOT, 'src/server/services/LangGraphResearchService.ts'),
  join(ROOT, 'src/server/services/ResearchAgentRunner.ts'),
  join(ROOT, 'scripts/lib/langGraphLauncher.ts'),
  join(ROOT, 'src/server/research/researchRecommendations.ts'),
].filter(existsSync);

const FORBIDDEN_TS_PATTERNS: Array<[string, RegExp]> = [
  ['imports RiskEngine', /from ['"][^'"]*RiskEngine['"]/],
  ['imports OrderManagement', /from ['"][^'"]*OrderManagement['"]/],
  ['imports BrokerManager', /from ['"][^'"]*BrokerManager['"]/],
  ['imports ChiefTraderAgent', /from ['"][^'"]*ChiefTraderAgent['"]/],
  ['imports the EventBus', /from ['"][^'"]*core\/EventBus['"]/],
  ['calls .placeOrder(', /\.placeOrder\(/],
  ['calls emitTradeIdea', /emitTradeIdea\(/],
  ['emits CHIEF_APPROVED_IDEA', /CHIEF_APPROVED_IDEA/],
  ['emits TRADE_IDEA_GENERATED', /TRADE_IDEA_GENERATED/],
  ['references BrokerManager.getInstance', /BrokerManager\.getInstance\(/],
];

describe('LangGraph research service: Node-side boundary', () => {
  it('found the expected new files (this test is not vacuous)', () => {
    expect(NODE_SIDE_FILES.length).toBe(4);
  });

  it('none of the new Node-side LangGraph files import or call any protected-spine symbol', () => {
    const hits: string[] = [];
    for (const f of NODE_SIDE_FILES) {
      const text = readFileSync(f, 'utf8');
      for (const [label, pattern] of FORBIDDEN_TS_PATTERNS) {
        if (pattern.test(text)) hits.push(`${rel(f)}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the new research route never bypasses ChiefTrader/RiskEngine/OMS itself', () => {
    const text = readFileSync(join(ROOT, 'src/server/routes/researchRoutes.ts'), 'utf8');
    // The route file legitimately imports many research/* modules - only assert it never imports
    // the four protected-spine symbols directly (it already didn't before this session's change;
    // this locks that in going forward).
    for (const [label, pattern] of FORBIDDEN_TS_PATTERNS) {
      if (label.startsWith('imports')) expect(pattern.test(text), `researchRoutes.ts ${label}`).toBe(false);
    }
  });

  it('LangGraphResearchService.ts never accesses a broker-credential env var', () => {
    const text = readFileSync(join(ROOT, 'src/server/services/LangGraphResearchService.ts'), 'utf8');
    expect(/ALPACA_(API|SECRET)_KEY/.test(text)).toBe(false);
    expect(/IBKR_/.test(text)).toBe(false);
  });

  it('config/langGraphResearch.json only allows a loopback base URL', () => {
    const raw = readFileSync(join(ROOT, 'config/langGraphResearch.json'), 'utf8');
    const json = JSON.parse(raw);
    expect(json.baseUrl.startsWith('http://127.0.0.1')).toBe(true);
  });
});

describe('LangGraph research service: Python-side boundary (Node-side belt-and-suspenders check)', () => {
  const PY_DIR = join(ROOT, 'langgraph-research', 'app');
  const PY_FILES = walkFiles(PY_DIR).filter((f) => f.endsWith('.py'));

  const FORBIDDEN_PY_PATTERNS: Array<[string, RegExp]> = [
    ['mentions RiskEngine', /\bRiskEngine\b/],
    ['mentions OrderManagement', /\bOrderManagement\b/],
    ['mentions BrokerManager', /\bBrokerManager\b/],
    ['mentions ChiefTraderAgent', /\bChiefTraderAgent\b/],
    ['calls place_order/placeOrder', /place_?[Oo]rder\(/],
    ['references the trading database file', /argus\.db/],
    ['references an Alpaca credential env var', /ALPACA_(API|SECRET)_KEY/],
    ['references an IBKR env var', /IBKR_/],
    ['opens a sqlite connection directly', /sqlite3\.connect\(/],
  ];

  it('found the Python app directory (this test is not vacuous)', () => {
    expect(PY_FILES.length).toBeGreaterThan(0);
  });

  it('no Python file in the service mentions a protected-spine symbol, a broker credential, or the trading database', () => {
    const hits: string[] = [];
    for (const f of PY_FILES) {
      const text = readFileSync(f, 'utf8');
      for (const [label, pattern] of FORBIDDEN_PY_PATTERNS) {
        if (pattern.test(text)) hits.push(`${rel(f)}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the Python service binds to 127.0.0.1 only', () => {
    const text = readFileSync(join(PY_DIR, 'server.py'), 'utf8');
    expect(text.includes('"127.0.0.1"')).toBe(true);
    expect(text.includes('"0.0.0.0"')).toBe(false);
  });
});

describe('LangGraph research service: Phase 3 human-review surface boundary', () => {
  const FRONTEND_FILE = join(ROOT, 'src/components/StrategyResearchRecommendations.tsx');

  const FORBIDDEN_UI_ACTION_PATTERNS: Array<[string, RegExp]> = [
    ['a Promote button/control', />\s*Promote\b/i],
    ['an Enable Strategy control', /Enable Strategy/i],
    ['a Live Trading control', /Live Trading/i],
    ['a risk-override control', /Risk Override/i],
    ['an order-placing control', /Place Order|Submit Order/i],
    ['an "Approve trade" control', /Approve Trade/i],
    ['a fetch to a mutating trading route', /fetch\(\s*[`'"]\/api\/v1\//],
    ['a fetch to /settings, /toggle, or /liquidate', /fetch\([^)]*(\/settings|\/toggle|\/liquidate)/],
    ['calls placeOrder', /\.placeOrder\(/],
  ];

  it('found the new Phase 3 frontend file (this test is not vacuous)', () => {
    expect(existsSync(FRONTEND_FILE)).toBe(true);
  });

  it('the human-review panel exposes no trading-control action, only the one advisory research-run trigger', () => {
    const text = readFileSync(FRONTEND_FILE, 'utf8');
    const hits: string[] = [];
    for (const [label, pattern] of FORBIDDEN_UI_ACTION_PATTERNS) {
      if (pattern.test(text)) hits.push(label);
    }
    expect(hits).toEqual([]);
  });

  it('the human-review panel only fetches research-namespaced v2 routes', () => {
    const text = readFileSync(FRONTEND_FILE, 'utf8');
    const fetchCalls = [...text.matchAll(/fetch\(\s*`([^`]+)`/g), ...text.matchAll(/fetch\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const url of fetchCalls) {
      expect(url.startsWith('/api/v2/research/')).toBe(true);
    }
  });

  it('the Phase 3 read API routes in researchRoutes.ts are GET-only (no write handler shares the strategy-recommendations path)', () => {
    const text = readFileSync(join(ROOT, 'src/server/routes/researchRoutes.ts'), 'utf8');
    expect(/v2Router\.get\('\/research\/strategy-recommendations\/:recommendationId'/.test(text)).toBe(true);
    expect(/v2Router\.get\('\/research\/strategy-recommendations'/.test(text)).toBe(true);
    expect(/v2Router\.(post|put|patch|delete)\('\/research\/strategy-recommendations/.test(text)).toBe(false);
  });
});
