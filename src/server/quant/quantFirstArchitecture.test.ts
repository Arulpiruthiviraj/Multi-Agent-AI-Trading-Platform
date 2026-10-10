// LABEL: ARCHITECTURE_INVARIANT - static guarantees: the deterministic quant path can never grow a second order path, an LLM dependency, or a direct line to the execution spine.
/**
 * Quant-First architecture protection tests (Phase 16.11-16.15, 16.25).
 *
 * Static guarantees, in the style of src/server/architecture.protection.test.ts:
 * the deterministic quant path can never grow a second order path, an LLM dependency,
 * or a direct line to the execution spine. Comments documenting the absence don't count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTradeIdeaOrigin, isQuantClaimingOrigin } from '../core/tradeIdeaProvenance';

const ROOT = join(process.cwd());

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8');
}

/** Strip line and block comments so doc comments naming a module don't count as importing it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S])/gm, '$1')
    .split('\n')
    .map((line) => {
      // naive but sufficient: cut // comments outside string literals (no URLs in imports here)
      const idx = line.indexOf('//');
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
}

const QUANT_FILES = [
  'src/server/quant/QuantExecutionPolicy.ts',
  'src/server/quant/QuantStrategyAuthorization.ts',
  'src/server/core/tradeIdeaProvenance.ts',
];

// Import-target fragments that must never appear in a static or dynamic import of these files.
const FORBIDDEN_IMPORT_FRAGMENTS = [
  'BrokerManager',
  'OrderManagement',
  'RiskEngine',
  'ChiefTraderAgent',
  'EventBus',
  'AIRouter',
  'ConsensusDebate',
  'BullResearcher',
  'BearResearcher',
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'ollama',
  'openrouter',
  'nvidia',
];

function importedFragments(code: string): string[] {
  const hits: string[] = [];
  const importRe = /(?:from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    const target = (m[1] ?? m[2] ?? '').toLowerCase();
    for (const frag of FORBIDDEN_IMPORT_FRAGMENTS) {
      if (target.includes(frag.toLowerCase())) hits.push(`${frag} (via ${m[1] ?? m[2]})`);
    }
  }
  return hits;
}

describe('quant-first: no forbidden imports in the deterministic quant path', () => {
  for (const f of QUANT_FILES) {
    it(`${f} never imports spine/LLM modules`, () => {
      const code = stripComments(read(f));
      expect(importedFragments(code)).toEqual([]);
    });
  }
});

describe('quant-first: no second order path can exist in the quant path', () => {
  for (const f of QUANT_FILES) {
    it(`${f} never calls placeOrder`, () => {
      expect(stripComments(read(f))).not.toMatch(/\.placeOrder\(/);
    });

    it(`${f} never emits CHIEF_APPROVED_IDEA`, () => {
      const code = stripComments(read(f));
      expect(code).not.toMatch(/CHIEF_APPROVED_IDEA/);
    });

    it(`${f} never touches trading_state or the kill switch`, () => {
      const code = stripComments(read(f));
      expect(code).not.toMatch(/setTradingState/);
      expect(code).not.toMatch(/EMERGENCY_STOP/);
    });
  }

  it('QuantExecutionPolicy never references the OMS/BrokerManager singletons by name', () => {
    const code = stripComments(read('src/server/quant/QuantExecutionPolicy.ts'));
    expect(code).not.toMatch(/BrokerManager/);
    expect(code).not.toMatch(/OrderManagement/);
  });
});

describe('quant-first: provenance contract', () => {
  it("normalizeTradeIdeaOrigin('QUANT_VALIDATED') is OTHER — self-labeling is impossible", () => {
    expect(normalizeTradeIdeaOrigin('QUANT_VALIDATED')).toBe('OTHER');
  });

  it('missing/unknown origin normalizes to OTHER (never quant authority)', () => {
    for (const raw of [undefined, null, '', 'quux', 42, {}]) {
      expect(normalizeTradeIdeaOrigin(raw)).toBe('OTHER');
    }
  });

  it('only QUANT_STRATEGY claims quant provenance', () => {
    expect(isQuantClaimingOrigin('QUANT_STRATEGY')).toBe(true);
    for (const o of ['TECHNICAL', 'FORECAST', 'NEWS_EVENT', 'MACRO', 'FUNDAMENTAL', 'AI_RESEARCH', 'PORTFOLIO_EXIT', 'FAST_OPPORTUNITY_LANE', 'EXPERIMENTAL', 'OTHER'] as const) {
      expect(isQuantClaimingOrigin(o)).toBe(false);
    }
  });
});

describe('quant-first: policy config sanity', () => {
  it('quantDecisionPolicy.json registers QuantEngine as a producer and a sane support floor', async () => {
    const cfg = JSON.parse(read('config/quantDecisionPolicy.json'));
    expect(Array.isArray(cfg.quantProducerAgents)).toBe(true);
    expect(cfg.quantProducerAgents).toContain('QuantEngine');
    expect(cfg.minQuantSupportDimensions).toBeGreaterThanOrEqual(1);
    expect(cfg.minQuantSupportDimensions).toBeLessThanOrEqual(4);
  });

  it('safety thresholds are untouched by this change', async () => {
    const safety = JSON.parse(read('config/tradingSafety.json'));
    expect(safety.consensusApprovalThreshold).toBe(0.75);
    expect(safety.minIndependentAgreeingAgents).toBe(2);
  });
});
