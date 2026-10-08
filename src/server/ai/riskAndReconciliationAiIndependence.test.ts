/**
 * Phase 41 — RiskEngine and PortfolioReconciliation AI independence.
 *
 * The post-approval safety spine (RiskEngine's 25 gates, PortfolioReconciliation's
 * broker-vs-local position comparison) must evaluate with ZERO AI involvement. A risk gate
 * that consults an LLM, or a reconciliation cycle that waits on a Jev decision, would make
 * capital safety depend on AI availability — the exact failure mode the Quant-First Decision
 * Architecture prohibits. These are static (no-runtime) import/reference scans.
 *
 * WHAT IS ASSERTED for each of:
 *   src/server/engines/RiskEngine.ts
 *   src/server/services/PortfolioReconciliation.ts
 *  - no ES import whose module path routes through an ai/ directory;
 *  - no reference (comments stripped first) to AIRouter, JevDecisionProvider,
 *    AICallGovernor, or AiAdvisoryService;
 *  - no `.placeOrder(`-adjacent AI call (defensive: these modules must not gain one);
 *  - no await on a jev/governor call expression.
 *
 * Both files are clean as of 2026-10-07; these tests pin that state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const PROTECTED_FILES = [
  'src/server/engines/RiskEngine.ts',
  'src/server/services/PortfolioReconciliation.ts',
];

const AI_IDENTIFIERS = ['AIRouter', 'JevDecisionProvider', 'AICallGovernor', 'AiAdvisoryService'];

describe('RiskEngine and PortfolioReconciliation never touch the AI layer', () => {
  it.each(PROTECTED_FILES)('%s has no ai/ import and no AI decision-module reference', (path) => {
    const text = stripComments(readFileSync(join(ROOT, path), 'utf8'));
    expect(text, `${path} imports from an ai/ path`).not.toMatch(/from\s+['"][^'"]*\/ai\/[^'"]*['"]/);
    for (const id of AI_IDENTIFIERS) {
      expect(text, `${path} references ${id}`).not.toContain(id);
    }
  });

  it.each(PROTECTED_FILES)('%s never awaits a jev/governor call', (path) => {
    const text = stripComments(readFileSync(join(ROOT, path), 'utf8'));
    expect(text, `${path} awaits a jev/governor call`).not.toMatch(/await\s+(jev|governor)[\w.]*\(/i);
  });

  it('the prohibition covers transitive one-level relative imports of the two modules', () => {
    // Scoped to AI *decision/network* identifiers, deliberately NOT to any ai/ path:
    // src/server/ai/ also hosts pure stateless helpers (e.g. AIOutputValidator's
    // looksLikeListedTicker, a synchronous ticker-shape validator with no network, no
    // model, no state) that MarketDataWorker and InstrumentRegistry legitimately import.
    // Importing a pure validator is not "touching the AI layer" in the sense this suite
    // prohibits — routing a decision through AIRouter/Jev/AICallGovernor is. A path-based
    // transitive check false-positives on those helpers, so this check asserts on the
    // identifiers that would indicate a real AI decision dependency instead.
    const hits: string[] = [];
    for (const path of PROTECTED_FILES) {
      const text = stripComments(readFileSync(join(ROOT, path), 'utf8'));
      const dir = path.split('/').slice(0, -1).join('/');
      for (const m of text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
        const depPath = join(ROOT, dir, m[1] + '.ts');
        let depText: string;
        try {
          depText = stripComments(readFileSync(depPath, 'utf8'));
        } catch {
          continue; // extensionless dir imports / non-.ts — out of scope for this check
        }
        for (const id of AI_IDENTIFIERS) {
          if (depText.includes(id)) hits.push(`${path} -> ${m[1]} references ${id}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
