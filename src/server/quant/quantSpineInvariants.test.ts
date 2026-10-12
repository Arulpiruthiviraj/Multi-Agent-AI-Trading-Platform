// LABEL: ARCHITECTURE_INVARIANT - locks router ordering, the call-time nature of the paper-only lock, and quant-approval code shapes. Static/invariant guarantee, not a trading outcome.
/**
 * Part-31 architecture invariant tests for the quant-first decision path
 * (Workstream F, 2026-10-08).
 *
 * These lock code SHAPES the runtime behavior depends on, in the style of
 * src/server/architecture.protection.test.ts and quantFirstArchitecture.test.ts.
 * Each test targets a gap those suites do not cover (checked 2026-10-08):
 *
 *  - quantFirstArchitecture.test.ts covers the three quant files' imports and the
 *    absence of order placement there, but not the router's ordering or ChiefTrader
 *    itself.
 *  - architecture.protection.test.ts covers CHIEF_APPROVED_IDEA emitter allowlists
 *    and the extension zone, but not the quant router branch ordering, the call-time
 *    nature of the paper-only lock, or the quant approval's convergence primitives.
 *  - phase21.invariants.test.ts covers "no second OMS placeOrder path" and the 27-gate
 *    catalog, but not the quant-policy routing shape.
 *
 * No test here duplicates a passing assertion from those suites.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd());

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8');
}

/** Strip line and block comments so doc comments naming a module don't count as importing it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
}

/**
 * Extract the body of a class method starting at the given signature marker,
 * by brace matching. The parameter list itself may contain { } object-type
 * literals (e.g. `idea: { traceId: string, ... }`), so paren-match past the
 * signature before looking for the method body's opening brace.
 */
function extractMethodBody(code: string, signatureMarker: string): string {
  const start = code.indexOf(signatureMarker);
  expect(start, `expected to find ${signatureMarker}`).toBeGreaterThan(-1);
  const parenOpen = code.indexOf('(', start);
  expect(parenOpen).toBeGreaterThan(-1);
  let pdepth = 0;
  let sigEnd = -1;
  for (let i = parenOpen; i < code.length; i++) {
    if (code[i] === '(') pdepth++;
    else if (code[i] === ')') {
      pdepth--;
      if (pdepth === 0) { sigEnd = i; break; }
    }
  }
  expect(sigEnd, `unbalanced parens in signature ${signatureMarker}`).toBeGreaterThan(-1);
  const openIdx = code.indexOf('{', sigEnd);
  expect(openIdx).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  throw new Error(`unbalanced braces extracting ${signatureMarker}`);
}

/**
 * Extract the body of a top-level exported function by brace matching from its
 * declaration marker.
 */
function extractFunctionBody(code: string, declMarker: string): string {
  const start = code.indexOf(declMarker);
  expect(start, `expected to find ${declMarker}`).toBeGreaterThan(-1);
  const openIdx = code.indexOf('{', start);
  expect(openIdx).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  throw new Error(`unbalanced braces extracting ${declMarker}`);
}

describe('Part-31: quant router ordering invariants (ChiefTraderAgent)', () => {
  it('the QUANT_STRATEGY routing branch is guarded by the risk-exit check FIRST — a risk exit can never be diverted into the quant policy even if mis-tagged', () => {
    const code = stripComments(read('src/server/services/ChiefTraderAgent.ts'));
    // 2026-10-08 defect hunt (F3, risk-exit spoofing): the guard was renamed isRiskExit ->
    // isExitShaped and strengthened - it now excludes agent SELLs of ANY origin (not just
    // PORTFOLIO_EXIT-stamped) from the quant router. The routing branch must read:
    // if (!this.isExitShaped(idea) && normalizeTradeIdeaOrigin(idea.origin) === 'QUANT_STRATEGY')
    // — the exit-shape exclusion must come before the quant-origin check in the same condition,
    // so reordering the operands or dropping the guard fails this test.
    expect(code).toMatch(
      /if\s*\(\s*!this\.isExitShaped\(idea\)\s*&&\s*normalizeTradeIdeaOrigin\(idea\.origin\)\s*===\s*['"]QUANT_STRATEGY['"]\s*\)/,
    );
  });

  // 2026-10-11 (consensus-bypass remediation): evaluateQuantPolicy was renamed to
  // evaluateQuantPolicyPrefilter and demoted to a fail-closed pre-filter (boolean return).
  // The direct-approval branch is removed — a policy pass falls through to the standard
  // consensus intake.
  it('evaluateQuantPolicyPrefilter is invoked from exactly one place, behind the AUTHORIZED_QUANT_POLICY check', () => {
    const code = stripComments(read('src/server/services/ChiefTraderAgent.ts'));
    const calls = code.match(/await this\.evaluateQuantPolicyPrefilter\(/g) ?? [];
    expect(calls.length).toBe(1);
    const callIdx = code.indexOf('await this.evaluateQuantPolicyPrefilter(');
    const preceding = code.slice(Math.max(0, callIdx - 600), callIdx);
    expect(preceding).toMatch(/authorization\.authority\s*===\s*['"]AUTHORIZED_QUANT_POLICY['"]/);
    // The AUTHORIZED gate must be the nearest authority check before the call: the
    // prefilter call sits inside that if-block (comment lines may intervene).
    const ifIdx = preceding.lastIndexOf("authorization.authority === 'AUTHORIZED_QUANT_POLICY'");
    expect(ifIdx).toBeGreaterThan(-1);
    const between = preceding.slice(ifIdx);
    expect(between).not.toMatch(/authorization\.authority\s*===\s*['"](?!AUTHORIZED_QUANT_POLICY)[A-Z_]+['"]/);
    // No remnant of the old direct-approval method name may survive.
    expect(code).not.toMatch(/await this\.evaluateQuantPolicy\(/);
  });

  // 2026-10-11 (consensus-bypass remediation): the prefilter must NEVER approve. The
  // removed branch approved with threshold: 0 ("never compared against") and
  // independentAgreeingAgents: 0 / requiredAgents: 0 — a silent architectural exception
  // to the standing consensus invariants. This test pins the remediation: the prefilter
  // body contains no approval primitive at all, and no threshold: 0 survives anywhere
  // in ChiefTraderAgent.
  it('the quant prefilter can never approve: no approval primitives, no threshold: 0, boolean return', () => {
    const code = stripComments(read('src/server/services/ChiefTraderAgent.ts'));
    const body = extractMethodBody(code, 'private async evaluateQuantPolicyPrefilter(');
    expect(body).not.toMatch(/emitChiefApproval\(/);
    expect(body).not.toMatch(/recordConsensusTransaction\(/);
    expect(body).not.toMatch(/\.placeOrder\(/);
    expect(body).not.toMatch(/BrokerManager/);
    expect(body).not.toMatch(/OrderManagement/);
    expect(body).not.toMatch(/RiskEngine/);
    // No direct CHIEF_APPROVED_IDEA emission either.
    expect(body).not.toMatch(/\.emit\(\s*(EVENTS\.CHIEF_APPROVED_IDEA|['"]CHIEF_APPROVED_IDEA['"])/);
    expect(body).not.toMatch(/setTradingState/);
    expect(body).not.toMatch(/EMERGENCY_STOP/);
    // The bypass's fingerprint — threshold: 0 "never compared against" — must not
    // survive anywhere in the file. The only approval gate is the consensus path's
    // CONSENSUS_APPROVAL_THRESHOLD (0.75, strict >) + MIN_INDEPENDENT_AGREEING_AGENTS.
    expect(code).not.toMatch(/threshold:\s*0\b/);
    // The prefilter returns a boolean verdict; the signature says so.
    expect(code).toMatch(/private async evaluateQuantPolicyPrefilter\([\s\S]*?\): Promise<boolean> \{/);
  });

  it('ChiefTraderAgent has no executable order-placement path of its own (comments do not count)', () => {
    const code = stripComments(read('src/server/services/ChiefTraderAgent.ts'));
    expect(code).not.toMatch(/\.placeOrder\(/);
    expect(code).not.toMatch(/from\s+['"][^'"]*BrokerManager['"]/);
    expect(code).not.toMatch(/from\s+['"][^'"]*OrderManagement['"]/);
  });
});

describe('Part-31: paper-only lock is evaluated at call time, never cached', () => {
  it('isPaperTradingOnlyEnforced reads process.env on every call (behavioral: no cached snapshot)', async () => {
    // Behavioral proof a cached module-level snapshot cannot provide: flip the env var
    // between calls and require the return value to track it. A stale cache would fail
    // the second assertion. (Source-surgery was tried first and proved brittle: the env
    // key legitimately appears in sibling functions and comments of the same module.)
    const { isPaperTradingOnlyEnforced } = await import('../core/tradingModeEnv');
    const prev = process.env.PAPER_TRADING_ONLY;
    try {
      process.env.PAPER_TRADING_ONLY = 'true';
      expect(isPaperTradingOnlyEnforced()).toBe(true);
      process.env.PAPER_TRADING_ONLY = 'false';
      expect(isPaperTradingOnlyEnforced()).toBe(false);
      delete process.env.PAPER_TRADING_ONLY;
      expect(isPaperTradingOnlyEnforced()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });

  it('the authorization module calls the lock function at resolve time (no imported snapshot)', () => {
    const code = stripComments(read('src/server/quant/QuantStrategyAuthorization.ts'));
    expect(code).toMatch(/isPaperTradingOnlyEnforced\(\)/);
    expect(code).not.toMatch(/const\s+\w*[Ll]ock\w*\s*=\s*isPaperTradingOnlyEnforced\(\)/);
  });
});
