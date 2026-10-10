/**
 * TS<->Java bridge CONTRACT test (static analysis - no live Java required).
 *
 * QuantCoreBridge.ts is the ONLY TypeScript caller of the Java quant core
 * (tradingSafety.quantJavaCoreBaseUrl); QuantCoreServer.java registers every
 * Java endpoint via server.createContext(). This test parses both source files
 * as text and asserts the contract holds in both directions, so any future
 * drift fails loudly:
 *
 *  1. Every fetch() in QuantCoreBridge.ts resolves to a registered Java context
 *     (prefix match - Java registers "/api/v1/indicators/" and TS appends the symbol).
 *  2. The HTTP method TS sends (explicit `method:` or default GET) is the method
 *     the Java handler accepts ("GET"/"POST".equals(exchange.getRequestMethod())).
 *  3. Every response field TS asserts via validateFiniteNumericFields(body, [...])
 *     is actually written by the Java handler (m.put("field") / Map.of("field"),
 *     including *ToJson helper bodies the handler delegates to).
 *  4. Where TS calls validateSymbolEcho(body, ...), Java writes a "symbol" key.
 *  5. Reverse coverage: every Java-registered endpoint EXCEPT the declared
 *     KNOWN_DEAD_JAVA_ENDPOINTS has at least one TS caller - a newly added Java
 *     endpoint with no caller, or a newly orphaned one, fails here.
 *  6. The KNOWN_DEAD_JAVA_ENDPOINTS (/api/v1/evaluate, /api/v1/institutional/pairs)
 *     have ZERO TS callers - documents the intentional dead state worker 3 found.
 *     Wiring one up requires updating this table, not silently drifting.
 *
 * Safety: this test never imports the bridge and never touches the network.
 * It cannot place orders, touch ChiefTrader/RiskEngine/OMS, or change thresholds.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TS_FILE = path.join(REPO_ROOT, 'src/server/services/QuantCoreBridge.ts');
const JAVA_FILE = path.join(
  REPO_ROOT,
  'quant-core-java/src/main/java/io/argus/quantcore/server/QuantCoreServer.java',
);

/** Java endpoints registered but intentionally without a TS caller (worker 3 inventory). */
const KNOWN_DEAD_JAVA_ENDPOINTS = ['/api/v1/evaluate', '/api/v1/institutional/pairs'];

interface TsCall {
  tsMethod: string;
  urlTemplate: string;
  httpMethod: string;
  validatedFields: string[];
  validatesSymbolEcho: boolean;
}

interface JavaEndpoint {
  contextPath: string;
  handler: string;
  acceptedMethod: string | null;
  responseKeys: Set<string>;
}

/** Extract the brace-delimited body starting at the given '{' index (brace counting). */
function extractBraceBody(src: string, openBraceIdx: number): string {
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx + 1, i);
    }
  }
  throw new Error(`unbalanced braces from index ${openBraceIdx}`);
}

/** Find the enclosing `async name(` method for a source index; return name + body. */
function enclosingAsyncMethod(src: string, idx: number): { name: string; body: string } {
  const re = /\basync (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(src)) !== null && m.index < idx) last = m;
  if (!last) throw new Error(`no enclosing async method for index ${idx}`);
  const braceIdx = src.indexOf('{', last.index + last[0].length);
  return { name: last[1], body: extractBraceBody(src, braceIdx) };
}

function extractTsCalls(tsSrc: string): TsCall[] {
  const calls: TsCall[] = [];
  const re = /fetch\(`\$\{tradingSafety\.quantJavaCoreBaseUrl\}([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tsSrc)) !== null) {
    const urlTemplate = m[1];
    const optionsWindow = tsSrc.slice(m.index, m.index + 900);
    const methodMatch = optionsWindow.match(/method:\s*'(GET|POST|PUT|DELETE|PATCH)'/);
    const { name, body } = enclosingAsyncMethod(tsSrc, m.index);
    const validatedFields: string[] = [];
    const vf = body.match(/validateFiniteNumericFields\(\s*body\s*,\s*\[([\s\S]*?)\]/);
    if (vf) {
      const fieldRe = /'([^']+)'/g;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(vf[1])) !== null) validatedFields.push(fm[1]);
    }
    calls.push({
      tsMethod: name,
      urlTemplate,
      httpMethod: methodMatch ? methodMatch[1] : 'GET', // fetch() with no method: is GET
      validatedFields,
      validatesSymbolEcho: /validateSymbolEcho\(\s*body/.test(body),
    });
  }
  return calls;
}

/** Collect "key" literals from m.put("key", ...) and Map.of("key", ...) in a Java body. */
function collectJsonKeys(javaBody: string): Set<string> {
  const keys = new Set<string>();
  const re = /(?:m\.put|Map\.of)\("([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(javaBody)) !== null) keys.add(m[1]);
  return keys;
}

function extractJavaEndpoints(javaSrc: string): JavaEndpoint[] {
  const endpoints: JavaEndpoint[] = [];
  const ctxRe = /server\.createContext\("([^"]+)",\s*bounded\(this::(\w+)\)\)/g;
  let m: RegExpExecArray | null;
  while ((m = ctxRe.exec(javaSrc)) !== null) {
    const [, contextPath, handler] = m;
    const handlerRe = new RegExp(`private void ${handler}\\s*\\([^)]*\\)[^{]*\\{`);
    const hm = handlerRe.exec(javaSrc);
    if (!hm) throw new Error(`Java handler ${handler} body not found`);
    const body = extractBraceBody(javaSrc, javaSrc.indexOf('{', hm.index + hm[0].length - 1));
    const methodCheck = body.match(/"([A-Z]+)"\.equals\(exchange\.getRequestMethod\(\)\)/);
    const responseKeys = collectJsonKeys(body);
    // Follow *ToJson(...) delegation: response keys live in the helper bodies.
    const helperRe = /(\w+ToJson)\s*\(/g;
    let h: RegExpExecArray | null;
    while ((h = helperRe.exec(body)) !== null) {
      const defRe = new RegExp(
        `private static Map<String,\\s*Object> ${h[1]}\\s*\\([^)]*\\)\\s*\\{`,
      );
      const dm = defRe.exec(javaSrc);
      if (dm) {
        const helperBody = extractBraceBody(javaSrc, javaSrc.indexOf('{', dm.index + dm[0].length - 1));
        for (const k of collectJsonKeys(helperBody)) responseKeys.add(k);
      }
    }
    endpoints.push({ contextPath, handler, acceptedMethod: methodCheck ? methodCheck[1] : null, responseKeys });
  }
  return endpoints;
}

/** Normalize a TS URL template so it can be prefix-matched against a Java context path. */
function normalizeTsUrl(urlTemplate: string): string {
  return urlTemplate.replace(/\$\{[^}]+\}/g, '{}');
}

function findJavaEndpoint(tsCall: TsCall, endpoints: JavaEndpoint[]): JavaEndpoint | undefined {
  const normalized = normalizeTsUrl(tsCall.urlTemplate);
  return endpoints.find((e) => normalized.startsWith(e.contextPath));
}

const tsSrc = fs.readFileSync(TS_FILE, 'utf8');
const javaSrc = fs.readFileSync(JAVA_FILE, 'utf8');
const tsCalls = extractTsCalls(tsSrc);
const javaEndpoints = extractJavaEndpoints(javaSrc);

describe('QuantCoreBridge <-> QuantCoreServer contract (static)', () => {
  it('parses a non-trivial call inventory on both sides (test self-check)', () => {
    // Guards against the regexes silently matching nothing after a refactor.
    expect(tsCalls.length).toBeGreaterThanOrEqual(15);
    expect(javaEndpoints.length).toBeGreaterThanOrEqual(15);
  });

  it('every TS bridge fetch resolves to a registered Java endpoint', () => {
    const unmapped = tsCalls.filter((c) => !findJavaEndpoint(c, javaEndpoints));
    expect(
      unmapped.map((c) => `${c.tsMethod}: ${c.urlTemplate}`),
      'TS calls with no Java endpoint - drift!',
    ).toEqual([]);
  });

  it('HTTP methods agree: TS-sent method is the method the Java handler accepts', () => {
    const mismatches: string[] = [];
    for (const c of tsCalls) {
      const ep = findJavaEndpoint(c, javaEndpoints)!;
      if (ep.acceptedMethod && ep.acceptedMethod !== c.httpMethod) {
        mismatches.push(`${c.tsMethod} sends ${c.httpMethod} to ${c.urlTemplate} but ${ep.handler} requires ${ep.acceptedMethod}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every TS-validated response field is written by the Java handler', () => {
    const missing: string[] = [];
    for (const c of tsCalls) {
      const ep = findJavaEndpoint(c, javaEndpoints)!;
      for (const f of c.validatedFields) {
        if (!ep.responseKeys.has(f)) {
          missing.push(`${c.tsMethod} validates "${f}" but ${ep.handler} never writes it`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('symbol-echo contract: where TS validates the echo, Java writes "symbol"', () => {
    const missing: string[] = [];
    for (const c of tsCalls) {
      if (!c.validatesSymbolEcho) continue;
      const ep = findJavaEndpoint(c, javaEndpoints)!;
      if (!ep.responseKeys.has('symbol')) {
        missing.push(`${c.tsMethod} validates symbol echo but ${ep.handler} never writes "symbol"`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every live Java endpoint has at least one TS caller (reverse coverage)', () => {
    const uncovered = javaEndpoints
      .filter((e) => !KNOWN_DEAD_JAVA_ENDPOINTS.includes(e.contextPath))
      .filter((e) => !tsCalls.some((c) => findJavaEndpoint(c, javaEndpoints) === e))
      .map((e) => `${e.contextPath} (${e.handler})`);
    expect(uncovered, 'Java endpoints with no TS caller - new endpoint or new dead code').toEqual([]);
  });

  it('known-dead Java endpoints have zero TS callers (intentional dead state)', () => {
    for (const dead of KNOWN_DEAD_JAVA_ENDPOINTS) {
      const callers = tsCalls.filter((c) => normalizeTsUrl(c.urlTemplate).startsWith(dead));
      expect(
        callers.map((c) => c.tsMethod),
        `${dead} is declared dead but has TS callers - update the contract table`,
      ).toEqual([]);
      // And the endpoint must still be registered (documents it exists but is uncalled).
      expect(javaEndpoints.some((e) => e.contextPath === dead)).toBe(true);
    }
  });

  it('QuantCoreBridge.ts is the only TS file calling the Java base URL', () => {
    // AGENTS.md: TS may call the Java engine only through the established bridge.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          const src = fs.readFileSync(full, 'utf8');
          if (/quantJavaCoreBaseUrl\}`/.test(src) && path.resolve(full) !== path.resolve(TS_FILE)) {
            hits.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    expect(hits).toEqual([]);
  });
});
