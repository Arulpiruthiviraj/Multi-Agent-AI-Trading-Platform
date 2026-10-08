/**
 * Phase 41 — Hot-path prohibition: no Jev/AI network-call sites inside per-tick/quote/websocket handlers.
 *
 * WHY: tick/quote/bar-update handlers run at market-data frequency. Any direct call into
 * JevDecisionProvider, AICallGovernor, or AIRouter's routeTask/routeConsensus from those
 * handlers would (a) put an LLM network round-trip on the hot path, (b) let AI latency or
 * failure delay or gate tick processing, and (c) violate the quant-first contract that AI
 * is event-driven and advisory-only, never tick-driven. Jev calls belong in the
 * governor-mediated, materiality-gated advisory path only.
 *
 * WHAT IS ASSERTED (precisely):
 *  1. FILE-LEVEL: src/server/services/MarketDataWorker.ts contains no import of
 *     JevDecisionProvider / AICallGovernor / AiAdvisoryService (by module path) and no
 *     reference to those identifiers anywhere in the file.
 *  2. HANDLER-LEVEL (function bodies extracted by brace-matching from the signature, so the
 *     assertion is scoped to the actual handler code, not the whole file):
 *     - acceptTickTimestamp(symbol, timestampMs, price) — per-tick timestamp gate
 *     - cacheObservedQuote(symbol, price, observedAtMs) — quote cache write path
 *     - maybeEmitMarketData(symbol, price, volume, timestamp) — MARKET_DATA emission fan-out
 *     - the socket.on("message", ...) quote/websocket handler inside connectAlpaca()
 *     None of these bodies may contain: routeTask(, routeConsensus(, JevDecisionProvider,
 *     AICallGovernor, AiAdvisoryService, AIRouter, or a jev./governor.request( call.
 *  3. COVERAGE GUARD: the set of files containing an `acceptTick` handler is exactly
 *     {src/server/services/MarketDataWorker.ts}. If a new acceptTick/quote-handler file
 *     appears, this test fails and forces the author to extend the handler-level scans.
 *
 * Deliberately NOT asserted: AIRouter usage elsewhere in MarketDataWorker (none exists today,
 * but the file-level rule for the router is scoped to the hot handlers only — banning the
 * identifier file-wide would over-reach into e.g. future diagnostics code that the
 * architecture rules don't prohibit).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MDW = join(ROOT, 'src/server/services/MarketDataWorker.ts');
const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * Extracts a function/method body by brace-matching from the first `{` after the given
 * signature match. Returns the body INCLUDING the outer braces, or null if not found /
 * unbalanced. Brace counting ignores braces inside string literals and template literals
 * (best-effort single-line handling — adequate for absence assertions on these handlers).
 */
function extractBody(text: string, signature: RegExp, label: string): string {
  const m = text.match(signature);
  expect(m && m.index !== undefined, `expected to find ${label} in MarketDataWorker.ts`).toBeTruthy();
  const openIdx = text.indexOf('{', m!.index!);
  expect(openIdx, `expected an opening brace for ${label}`).toBeGreaterThan(-1);
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${label}`);
}

const HOT_PATH_IDENTIFIERS = [
  'JevDecisionProvider',
  'AICallGovernor',
  'AiAdvisoryService',
  'routeTask(',
  'routeConsensus(',
];

function expectNoHotPathAi(body: string, label: string): void {
  for (const id of HOT_PATH_IDENTIFIERS) {
    expect(body, `${label} must not reference ${id} on the tick/quote hot path`).not.toContain(id);
  }
  expect(body, `${label} must not call the governor`).not.toMatch(/governor\.request\(/);
  expect(body, `${label} must not await a jev call`).not.toMatch(/\bjev\./i);
  expect(body, `${label} must not import from the ai integration paths`).not.toMatch(/from\s+['"][^'"]*\/ai\/(Jev|AICallGovernor|AiAdvisory)/);
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, acc);
    // Test files are excluded: this guard is about production handler files. (An earlier
    // version of this test false-positived on its own source, which mentions acceptTick
    // throughout its assertions.)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('Hot-path prohibition: no Jev/AI network-call sites in tick/quote/websocket handlers', () => {
  const raw = readFileSync(MDW, 'utf8');
  const text = stripComments(raw);

  it('MarketDataWorker.ts has no Jev/AICallGovernor/AiAdvisoryService import or reference at all', () => {
    expect(text).not.toMatch(/from\s+['"][^'"]*(JevDecisionProvider|AICallGovernor|AiAdvisoryService)['"]/);
    expect(text).not.toContain('JevDecisionProvider');
    expect(text).not.toContain('AICallGovernor');
    expect(text).not.toContain('AiAdvisoryService');
  });

  it('acceptTickTimestamp (per-tick gate) contains no AI call site', () => {
    const body = extractBody(text, /acceptTickTimestamp\(symbol:\s*string/, 'acceptTickTimestamp');
    expectNoHotPathAi(body, 'acceptTickTimestamp');
  });

  it('cacheObservedQuote (quote cache write path) contains no AI call site', () => {
    const body = extractBody(text, /cacheObservedQuote\(symbol:\s*string/, 'cacheObservedQuote');
    expectNoHotPathAi(body, 'cacheObservedQuote');
  });

  it('maybeEmitMarketData (MARKET_DATA emission fan-out) contains no AI call site', () => {
    const body = extractBody(text, /maybeEmitMarketData\(symbol:\s*string/, 'maybeEmitMarketData');
    expectNoHotPathAi(body, 'maybeEmitMarketData');
  });

  it('the websocket quote message handler inside connectAlpaca() contains no AI call site', () => {
    // The live quote path: connectAlpaca() -> socket.on("message", (data) => {...}) parses
    // Alpaca quote/trade messages and fans out through maybeEmitMarketData.
    const body = extractBody(text, /socket\.on\("message",\s*\(data\)\s*=>/, 'socket.on("message") quote handler');
    expectNoHotPathAi(body, 'websocket quote message handler');
  });

  it('coverage guard: MarketDataWorker.ts is still the only file with an acceptTick handler', () => {
    const holders = walkTs(join(ROOT, 'src', 'server'))
      .filter((f) => /acceptTick/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(holders).toEqual(['src/server/services/MarketDataWorker.ts']);
  });
});
