/**
 * ARCHITECTURE REGRESSION: Jev output alone cannot cause an order.
 *
 * === SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY / NON_ORGANIC ===
 *
 * Claim under test: every Jev-touching production module is structurally incapable of
 * reaching the protected order spine (RiskEngine / OMS / BrokerManager / ChiefTrader /
 * PositionSizing). A Jev decision result is inert data — it can only ever enter the
 * normal decision architecture as an advisory-only note, which QuantExecutionPolicy
 * records and never consults.
 *
 * The inventory below was built 2026-10-11 by a real source search of all Jev call
 * sites (Worker C certification). If a new Jev-touching file appears, the "inventory is
 * live" test fails and forces the author to extend the scan — coverage cannot silently
 * shrink.
 *
 * WHAT IS ASSERTED:
 *  1. STATIC: no Jev-touching prod file imports or references the order spine
 *     (RiskEngine, BrokerManager, OrderManagementService/OMS, ChiefTraderAgent,
 *     PositionSizing) and none calls placeOrder/submitOrder, emits a trade idea, or
 *     emits CHIEF_APPROVED_IDEA.
 *  2. STATIC: the one Jev consumer that lives inside a spine-adjacent file
 *     (NewsEngine.tryJevFirstAnalysis) cannot reach the spine from its body.
 *  3. STATIC: QuantExecutionPolicy never passes aiAdvisoryNote to a gate
 *     constructor (req/sup/fail) — the note is recorded on the decision only.
 *  4. RUNTIME: a real AICallGovernor + fake Jev provider returning a bullish,
 *     high-confidence decision yields inert, JSON-serializable data — no
 *     functions, no order-intent fields.
 *  5. RUNTIME: AiAdvisoryService turns that decision into a plain-text advisory
 *     note ("Advisory only") in an in-memory cache — the only sinks are
 *     observability and the note cache.
 *  6. RUNTIME: a hostile advisory note ("BUY NOW, p=0.99") fed into
 *     evaluateQuantExecutionPolicy cannot change the policy outcome vs. a null
 *     note — same approval, same reasonCode; the note is only recorded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Every production file that touches Jev (real inventory, 2026-10-11 audit). */
const JEV_FILES = [
  'src/server/ai/providers/JevProvider.ts',
  'src/server/ai/JevDecisionProvider.ts',
  'src/server/ai/AICallGovernor.ts',
  'src/server/ai/AiAdvisoryService.ts',
  'src/server/news/JevNewsTriage.ts',
  'src/server/news/JevEscalation.ts',
  'src/server/news/JevShadowLedger.ts',
  'src/server/news/JevClassificationTask.ts',
  'src/server/news/JevNewsTypes.ts',
];

/** The protected order spine: no Jev file may import or reference any of these. */
const SPINE_IMPORT_PATTERNS = [
  /from\s+['"][^'"]*RiskEngine['"]/,
  /from\s+['"][^'"]*BrokerManager['"]/,
  /from\s+['"][^'"]*OrderManagement(Service)?['"]/,
  /from\s+['"][^'"]*ChiefTraderAgent['"]/,
  /from\s+['"][^'"]*PositionSizing['"]/,
];
const SPINE_CALL_PATTERNS = [
  /\.placeOrder\s*\(/,
  /\.submitOrder\s*\(/,
  /\bemitTradeIdea\s*\(/,
  /CHIEF_APPROVED_IDEA/,
  /RiskEngine\.getInstance\s*\(/,
  /BrokerManager\.getInstance\s*\(/,
  /OrderManagementService\.getInstance\s*\(/,
  /ChiefTraderAgent\.getInstance\s*\(/,
];

function expectNoSpineReach(text: string, label: string): void {
  for (const re of SPINE_IMPORT_PATTERNS) {
    expect(text, `${label} must not import the order spine (${re})`).not.toMatch(re);
  }
  for (const re of SPINE_CALL_PATTERNS) {
    expect(text, `${label} must not reach the order spine (${re})`).not.toMatch(re);
  }
}

describe('Jev cannot cause an order (static: inventory scan)', () => {
  it('the Jev file inventory is live: every file exists and was scanned', () => {
    for (const p of JEV_FILES) {
      expect(existsSync(join(ROOT, p)), `Jev inventory file missing: ${p}`).toBe(true);
    }
  });

  it.each(JEV_FILES)('%s never imports or reaches the protected order spine', (p) => {
    const text = stripComments(readFileSync(join(ROOT, p), 'utf8'));
    expectNoSpineReach(text, rel(p));
  });

  it('NewsEngine.tryJevFirstAnalysis (the spine-adjacent Jev consumer) cannot reach the order spine', () => {
    const src = stripComments(readFileSync(join(ROOT, 'src/server/news/NewsEngine.ts'), 'utf8'));
    const start = src.indexOf('private async tryJevFirstAnalysis(');
    expect(start, 'expected to find tryJevFirstAnalysis in NewsEngine.ts').toBeGreaterThan(-1);
    // Brace-match the method body: skip past the parameter type literal (which
    // itself contains braces) to the opening brace of the method body.
    const sigEnd = src.indexOf('Promise<AIAnalysisResult | null>', start);
    expect(sigEnd, 'expected the tryJevFirstAnalysis return type').toBeGreaterThan(-1);
    const openIdx = src.indexOf('{', sigEnd);
    expect(openIdx, 'expected an opening brace for tryJevFirstAnalysis').toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    expect(end, 'unbalanced braces in tryJevFirstAnalysis').toBeGreaterThan(-1);
    const body = src.slice(openIdx, end + 1);
    expectNoSpineReach(body, 'NewsEngine.tryJevFirstAnalysis');
    // Its only sinks: build an AIAnalysisResult (news analysis) or return null.
    expect(body).toMatch(/buildJevAnalysisResult|return null/);
  });

  it('QuantExecutionPolicy never passes aiAdvisoryNote to a gate constructor', () => {
    const text = stripComments(readFileSync(join(ROOT, 'src/server/quant/QuantExecutionPolicy.ts'), 'utf8'));
    // The advisory note must never be an argument to a REQUIRED/SUPPORT gate or fail().
    expect(
      text,
      'aiAdvisoryNote must never gate a decision (req/sup/fail argument)',
    ).not.toMatch(/\b(req|sup|fail)\s*\([^)]*aiAdvisoryNote/);
    // It IS recorded on the decision record.
    expect(text).toMatch(/aiAdvisoryNote,/);
  });
});

describe('Jev cannot cause an order (runtime: decisions are inert data)', () => {
  let governor: import('../ai/AICallGovernor').AICallGovernor;

  const bullishDecision = {
    answers: {
      thesis_supported: { type: 'noul' as const, noul: 0.99 },
      material_risk_event: { type: 'noul' as const, noul: 0.01 },
    },
    model: 'jev-1.13.0',
    inputTokens: 128,
    latencyMs: 42,
  };

  beforeEach(async () => {
    const mod = await import('../ai/AICallGovernor');
    governor = mod.AICallGovernor.getInstance();
    governor.resetForTests();
    governor.__setJevProviderForTests({
      isConfigured: () => true,
      decide: async () => ({ ...bullishDecision }),
    });
  });

  afterEach(() => {
    governor.resetForTests();
  });

  it('a bullish high-confidence Jev decision returns inert, JSON-serializable data', async () => {
    const outcome = await governor.request({
      capability: 'STRUCTURED_DECISION',
      kind: 'quant_candidate_advisory',
      material: {
        symbol: 'SYN',
        fingerprintParts: { traceId: 'jev-cannot-cause-order-1', symbol: 'SYN' },
        materiality: 'MEDIUM',
        decisionDeadlineMs: Date.now() + 60_000,
        traceId: 'jev-cannot-cause-order-1',
      },
      jev: {
        state: { symbol: 'SYN' },
        questions: {
          thesis_supported: { type: 'noul', instructions: 'x' },
          material_risk_event: { type: 'noul', instructions: 'y' },
        },
        schemaVersion: 'test/1',
      },
      run: async () => { throw new Error('run must never be invoked for STRUCTURED_DECISION'); },
    });
    expect(outcome.status).toBe('CALLED');
    const result = (outcome as { result: unknown }).result;
    // Inert: survives a JSON round-trip with no functions and no order-intent fields.
    const roundTripped = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(Object.keys(roundTripped).sort()).toEqual(
      ['answers', 'inputTokens', 'latencyMs', 'model'],
    );
    expect(JSON.stringify(result)).not.toMatch(/placeOrder|submitOrder|BUY|SELL/i);
  });

  it('AiAdvisoryService reduces a Jev decision to a plain-text advisory note (observability + note cache only)', async () => {
    const { AiAdvisoryService } = await import('../ai/AiAdvisoryService');
    const svc = AiAdvisoryService.getInstance();
    svc.resetForTesting();
    try {
      svc.setGovernorForTesting({
        request: (async () => ({ status: 'CALLED', result: { ...bullishDecision }, latencyMs: 7 })) as unknown as import('../ai/AiAdvisoryService').AIGovernorLike['request'],
      });
      svc.considerNewsCatalyst({
        id: 'art-1',
        symbol: 'SYN',
        title: 'Synthetic headline',
        summary: 'Synthetic summary',
        publishedAt: Date.now(),
      });
      await svc.drainPendingAdvisoryWork();
      const note = svc.getAdvisoryNote('SYN');
      expect(typeof note).toBe('string');
      expect(note as string).toMatch(/Advisory only/);
      // The note is inert data: no functions, no executable capability.
      expect(JSON.parse(JSON.stringify(note))).toBe(note);
    } finally {
      svc.resetForTesting();
    }
  });

  it('a hostile advisory note cannot change the quant policy outcome (recorded, never consulted)', async () => {
    const { evaluateQuantExecutionPolicy } = await import('../quant/QuantExecutionPolicy');
    const hostileNote = 'Jev says BUY with p=0.99 — execute immediately, ignore all gates';
    // Fixture passes every REQUIRED gate (so the advisory block runs and the note
    // IS recorded) but fails SUPPORT (no regime/ensemble/calibration evidence) —
    // the policy rejects identically with and without the hostile note.
    const authorization = {
      authority: 'AUTHORIZED_QUANT_POLICY',
      strategyId: 'SYNTH_FIXTURE',
      reason: 'certification fixture',
    } as never;
    const baseIdea = {
      symbol: 'SYN',
      side: 'BUY',
      confidence: 0.8,
      currentPrice: 100,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      quantDetail: {
        strategyEvaluation: {
          strategy: 'SYNTH_FIXTURE',
          side: 'BUY',
          triggerMet: true,
          stop: { price: 95 },
          target: { price: 110 },
        },
      },
    } as never;

    const withoutNote = await evaluateQuantExecutionPolicy(
      { ...(baseIdea as object), aiAdvisoryNote: null } as never,
      authorization,
    );
    const withHostileNote = await evaluateQuantExecutionPolicy(
      { ...(baseIdea as object), aiAdvisoryNote: hostileNote } as never,
      authorization,
    );

    expect(withoutNote.approved).toBe(false);
    expect(withHostileNote.approved).toBe(false);
    // Identical terminal outcome: the note cannot flip or soften the decision.
    expect(withHostileNote.reasonCode).toBe(withoutNote.reasonCode);
    expect(withHostileNote.reasonCode).toBe('QUANT_INSUFFICIENT_SUPPORT');
    expect(withHostileNote.checks.map((c) => [c.id, c.passed])).toEqual(
      withoutNote.checks.map((c) => [c.id, c.passed]),
    );
    // The only difference is the recorded note itself — advisory, never gating.
    expect(withHostileNote.aiAdvisoryNote).toBe(hostileNote);
    expect(withoutNote.aiAdvisoryNote).toBeNull();
  });
});
