import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { aggregateWeeklyDigest } from './weeklyDigestAggregate';

/**
 * Architecture boundary for the post-market reflection module (src/server/reflection/).
 * Reflection is DIAGNOSTIC ONLY: it may read any table and summarize, but it must never
 * influence the live decision path. Same static-scan pattern as
 * src/server/premarket/premarketArchitectureBoundary.test.ts - proven precedent in this
 * codebase. Every future reflection file lands under this directory, so coverage grows
 * automatically with it.
 *
 * The five structural guarantees:
 *  (a) no reflection module imports BrokerManager/OMS/placeOrder paths
 *  (b) reflection never calls eventBus.emitTradeIdea / emitCHIEF_APPROVED_IDEA
 *  (c) reflection never writes to trades/fills/orders/risk_assessments (write-table allow-list)
 *  (d) no reflection code path mutates consensus thresholds, agent weights, or RiskEngine config
 *  (e) the weekly digest cannot promote a single-occurrence pattern
 */
const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}
/** Code with comments stripped - assertions must not trip on doc prose. */
function codeOnlyOf(file: string): string {
  return sourceOf(file).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

describe('Reflection - architecture boundary (diagnostic only)', () => {
  it('at least one non-test file exists (sanity - this suite should never silently cover zero files)', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('(a) no file imports BrokerManager, OMS, RiskEngine, ChiefTraderAgent, placeOrder, or a broker adapter', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) =>
        /BrokerManager|OrderManagement|RiskEngine|ChiefTraderAgent|placeOrder|AlpacaBroker|IBGatewaySocketAdapter|InteractiveBrokersWebApiAdapter|CoinbaseBroker|QuestradeBroker|InternalPaperBroker/.test(l),
      );
      expect(hit, f).toBe(false);
    }
  });

  it('(b) no file calls eventBus.emitTradeIdea or emits CHIEF_APPROVED_IDEA', () => {
    for (const f of FILES) {
      const code = codeOnlyOf(f);
      expect(code, f).not.toMatch(/\.emitTradeIdea\s*\(/);
      expect(code, f).not.toMatch(/emitCHIEF_APPROVED_IDEA/);
      expect(code, f).not.toMatch(/CHIEF_APPROVED_IDEA/);
    }
  });

  it('(c) reflection writes go only to allow-listed diagnostic reflection tables', () => {
    // Reads of any table are diagnostic and fine; WRITES are allow-listed to the tables
    // owned by the reflection workstreams themselves - never the live-path tables below.
    // (drizzle schema names and raw SQL table names for the same tables.)
    const WRITE_TABLE_ALLOW_LIST = new Set([
      'weeklyReflectionDigest', 'weekly_reflection_digest', // workstream K (this change)
      'reflectionSessionMetrics', 'reflection_session_metrics', // workstream I
      'moverCoverage', 'mover_coverage', // workstream H
    ]);
    const found = new Map<string, string>(); // table identifier -> file
    for (const f of FILES) {
      const code = codeOnlyOf(f);
      const patterns: RegExp[] = [
        /db\s*\.\s*insert\s*\(\s*schema\s*\.\s*([A-Za-z0-9_]+)/g,
        /db\s*\.\s*update\s*\(\s*schema\s*\.\s*([A-Za-z0-9_]+)/g,
        /db\s*\.\s*delete\s*\(\s*schema\s*\.\s*([A-Za-z0-9_]+)/g,
        /INSERT\s+INTO\s+[`"]?([A-Za-z0-9_]+)/gi,
        /UPDATE\s+[`"]?([A-Za-z0-9_]+)\s+SET/gi,
        /DELETE\s+FROM\s+[`"]?([A-Za-z0-9_]+)/gi,
      ];
      for (const re of patterns) {
        for (const m of code.matchAll(re)) {
          if (!found.has(m[1])) found.set(m[1], f);
        }
      }
    }
    expect(found.size).toBeGreaterThan(0); // the digest really does persist - zero writes would be a lie
    for (const [table, f] of found) {
      expect(WRITE_TABLE_ALLOW_LIST.has(table), `${f} writes to non-allow-listed table ${table}`).toBe(true);
    }
    // The sensitive live-path tables are never written, explicitly.
    for (const sensitive of ['trades', 'fills', 'orders', 'risk_assessments', 'riskAssessments']) {
      expect(found.has(sensitive), `reflection must never write ${sensitive}`).toBe(false);
    }
  });

  it('(d) no file mutates consensus thresholds, agent weights, or RiskEngine/tradingSafety config', () => {
    const MUTATION_PATTERNS: RegExp[] = [
      /\b(consensusApprovalThreshold|minIndependentAgreeingAgents|disagreementPenalty)\s*=[^=]/,
      /\bagentWeights\b\s*(\.\s*[A-Za-z0-9_]+\s*)?=[^=]/,
      /\btradingSafety\s*\.\s*[A-Za-z0-9_]+\s*=[^=]/,
      /Object\.assign\s*\(\s*tradingSafety/,
      /\bRiskEngine\s*\.\s*[A-Za-z0-9_]+\s*=[^=]/,
      /Object\.assign\s*\(\s*RiskEngine/,
    ];
    for (const f of FILES) {
      const code = codeOnlyOf(f);
      for (const re of MUTATION_PATTERNS) {
        expect(code, `${f} matches ${re}`).not.toMatch(re);
      }
    }
  });

  it('(e) the weekly digest cannot promote a single-occurrence pattern', () => {
    const oneDayOnly = [
      {
        tradingDate: '2026-10-05',
        blindSpots: [{ patternKey: 'NULL_ADV_LIQUIDITY_GATE', pattern: 'x', affectedSymbolCount: 9, evidence: 'A,B,C' }],
        findings: [],
        narratives: [],
        rejectedCandidateAudits: [],
      },
      { tradingDate: '2026-10-06', blindSpots: [], findings: [], narratives: [], rejectedCandidateAudits: [] },
      { tradingDate: '2026-10-07', blindSpots: [], findings: [], narratives: [], rejectedCandidateAudits: [] },
    ];
    expect(aggregateWeeklyDigest(oneDayOnly)).toEqual([]);

    const twoDays = [
      {
        tradingDate: '2026-10-05',
        blindSpots: [{ patternKey: 'NULL_ADV_LIQUIDITY_GATE', pattern: 'x', affectedSymbolCount: 9, evidence: 'A,B' }],
        findings: [],
        narratives: [],
        rejectedCandidateAudits: [],
      },
      {
        tradingDate: '2026-10-06',
        blindSpots: [{ patternKey: 'NULL_ADV_LIQUIDITY_GATE', pattern: 'x', affectedSymbolCount: 4, evidence: 'C' }],
        findings: [],
        narratives: [],
        rejectedCandidateAudits: [],
      },
    ];
    const promoted = aggregateWeeklyDigest(twoDays);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].patternKey).toBe('NULL_ADV_LIQUIDITY_GATE');
    expect(promoted[0].occurrences).toBe(2);
  });
});
