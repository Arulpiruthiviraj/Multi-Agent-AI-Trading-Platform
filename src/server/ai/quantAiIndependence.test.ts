/**
 * Phase 40/41 — Quant-side AI independence (Jev/AICallGovernor integration).
 *
 * Static (no-runtime) architecture tests proving the quant decision path never depends on
 * the AI layer. The Quant-First Decision Architecture requires: validated quant strategies
 * trade with ZERO AI involvement; AI (Jev structured decisions, AIRouter debates, advisory
 * notes) is advisory-only and can never gate, approve, or block the quant policy path.
 *
 * What this file asserts:
 *  1. QuantExecutionPolicy.ts, QuantStrategyAuthorization.ts and tradeIdeaProvenance.ts never
 *     import anything from src/server/ai/ and never reference the AI decision modules
 *     (AIRouter, JevDecisionProvider, AICallGovernor, AiAdvisoryService) — comments stripped
 *     first so a comment merely documenting the prohibition can't satisfy the check.
 *  2. (conditional on the sibling workers landing) JevDecisionProvider.ts / AICallGovernor.ts
 *     themselves never import the protected order spine
 *     (BrokerManager / OrderManagement / RiskEngine / ChiefTraderAgent) — the AI advisory
 *     layer must be structurally incapable of reaching the order path. Skipped until the
 *     sibling files exist; the scan set is computed from whatever is present.
 *  3. CHIEF_APPROVED_IDEA emitter discipline for the NEW integration area: no file under
 *     src/server/ai/ emits CHIEF_APPROVED_IDEA. This EXTENDS (does not duplicate)
 *     src/server/architecture.protection.test.ts, which keeps guarding the rest of the tree
 *     with its reviewed 4-file allowlist (ChiefTraderAgent, PipelineFlatten,
 *     telemetryPulse, EventBus internals). The new AI advisory modules live in src/server/ai/
 *     and must have zero emitters of their own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const QUANT_DECISION_FILES = [
  'src/server/quant/QuantExecutionPolicy.ts',
  'src/server/quant/QuantStrategyAuthorization.ts',
  'src/server/core/tradeIdeaProvenance.ts',
];

const AI_DECISION_IDENTIFIERS = [
  'AIRouter',
  'JevDecisionProvider',
  'AICallGovernor',
  'AiAdvisoryService',
];

/** Matches any ES import whose module path routes through an ai/ directory. */
const AI_PATH_IMPORT = /from\s+['"][^'"]*\/ai\/[^'"]*['"]/;

function walkNonTestTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkNonTestTs(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('Quant-side AI independence: quant decision modules never touch the AI layer', () => {
  it.each(QUANT_DECISION_FILES)('%s imports nothing from src/server/ai/ and references no AI decision module', (path) => {
    const text = stripComments(readFileSync(join(ROOT, path), 'utf8'));
    expect(text, `${path} imports from an ai/ path`).not.toMatch(AI_PATH_IMPORT);
    for (const id of AI_DECISION_IDENTIFIERS) {
      expect(text, `${path} references ${id}`).not.toContain(id);
    }
  });

  it('the prohibition is not satisfied by the ai/ import living in a re-exported dependency of the quant modules', () => {
    // Belt-and-braces: even if a quant module imported some neutral-looking helper, that helper
    // must not itself pull the AI decision modules in. Scan the direct relative imports of the
    // quant decision files one level deep.
    const hits: string[] = [];
    for (const path of QUANT_DECISION_FILES) {
      const text = stripComments(readFileSync(join(ROOT, path), 'utf8'));
      const dir = path.split('/').slice(0, -1).join('/');
      for (const m of text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
        const dep = m[1];
        for (const ext of ['', '.ts']) {
          const depPath = join(ROOT, dir, dep + ext);
          if (!existsSync(depPath) || depPath.endsWith('.test.ts')) continue;
          const depText = stripComments(readFileSync(depPath, 'utf8'));
          if (AI_PATH_IMPORT.test(depText)) hits.push(`${path} -> ${rel(depPath)} imports an ai/ path`);
          for (const id of AI_DECISION_IDENTIFIERS) {
            if (depText.includes(id)) hits.push(`${path} -> ${rel(depPath)} references ${id}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('AI advisory modules never reach the protected order spine', () => {
  const JEV_FILES = [
    'src/server/ai/JevDecisionProvider.ts',
    'src/server/ai/AICallGovernor.ts',
    'src/server/ai/AiAdvisoryService.ts',
  ].filter((p) => existsSync(join(ROOT, p)));

  // The AI advisory layer (Jev provider, call governor, fire-and-forget advisory service)
  // must be structurally incapable of reaching the order path. The scan runs against
  // every present file; if a file is ever deleted the scan self-skips and the
  // 'scan is live' test below fails loudly instead of letting coverage vanish silently.
  it.skipIf(JEV_FILES.length === 0)(
    'JevDecisionProvider/AICallGovernor/AiAdvisoryService never import BrokerManager, OrderManagement, RiskEngine or ChiefTraderAgent',
    () => {
      const hits: string[] = [];
      for (const path of JEV_FILES) {
        const text = stripComments(readFileSync(join(ROOT, path), 'utf8'));
        if (/from\s+['"][^'"]*(BrokerManager|OrderManagement|RiskEngine|ChiefTraderAgent)['"]/.test(text)) {
          hits.push(`${path}: imports the protected order spine`);
        }
        if (/BrokerManager\.getInstance\(/.test(text)) hits.push(`${path}: calls BrokerManager.getInstance()`);
        if (/\.placeOrder\(/.test(text)) hits.push(`${path}: calls placeOrder`);
        if (/emitTradeIdea\(/.test(text)) hits.push(`${path}: emits a trade idea`);
      }
      expect(hits).toEqual([]);
    },
  );

  it('the spine scan is live: all three sibling contracts are present and were scanned', () => {
    // If a sibling file is ever deleted, the scan above self-skips (skipIf) — this test
    // then fails loudly instead of letting the coverage vanish silently.
    expect(JEV_FILES).toContain('src/server/ai/JevDecisionProvider.ts');
    expect(JEV_FILES).toContain('src/server/ai/AICallGovernor.ts');
    expect(JEV_FILES).toContain('src/server/ai/AiAdvisoryService.ts');
  });
});

describe('CHIEF_APPROVED_IDEA emitter discipline: extension for the ai/ integration area', () => {
  it('no file under src/server/ai/ emits CHIEF_APPROVED_IDEA (extends the 4-file allowlist in architecture.protection.test.ts)', () => {
    // architecture.protection.test.ts keeps the reviewed 4-emitter allowlist for the whole tree.
    // The Jev/AICallGovernor integration lives in src/server/ai/; its home directory must have
    // ZERO emitters of its own — AI advisory code never approves a trade, directly or by event.
    const hits: string[] = [];
    for (const f of walkNonTestTs(join(ROOT, 'src', 'server', 'ai'))) {
      const text = readFileSync(f, 'utf8');
      if (/\.emit\(\s*(EVENTS\.CHIEF_APPROVED_IDEA|['"]CHIEF_APPROVED_IDEA['"])/.test(text)) {
        hits.push(rel(f));
      }
    }
    expect(hits).toEqual([]);
  });
});
