/**
 * TUI architecture protection (2026-10-06).
 *
 * The TUI is a presentation/controller layer over existing HTTP endpoints.
 * It must NEVER import BrokerManager, broker adapters, OMS internals,
 * RiskEngine internals, TradingEngine, or the database layer — and it must
 * never issue non-GET requests (read-only by default).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) acc.push(p);
  }
  return acc;
}

const TUI_FILES = walk(join(ROOT, 'scripts', 'tui'));
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');

const FORBIDDEN_IMPORTS = [
  'BrokerManager',
  'brokers/',
  "'OMS'",
  '"OMS"',
  'RiskEngine',
  'TradingEngine',
  'server/db',
  'better-sqlite3',
  'placeOrder',
  'submitOrder',
];

/** Strip line/block comments so doc mentions don't count as imports. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** True if the (comment-stripped) source really imports/uses the token in code. */
function hasRealReference(src: string, token: string): boolean {
  const code = codeOnly(src);
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Import statements (static or dynamic) whose module path contains the token
  if (new RegExp(`from\\s+['"][^'"]*${esc}`,).test(code)) return true;
  if (new RegExp(`import\\s*\\([^)]*${esc}`,).test(code)) return true;
  if (/^['"]/.test(token)) return false; // quoted tokens only count in import paths
  // Bare identifier actually used: property access or call (not prose in JSX text)
  return new RegExp(`\\b${esc}\\s*[.(]`,).test(code);
}

const FORBIDDEN_METHODS = ['method: \'POST\'', 'method: "POST"', 'method: \'PUT\'', 'method: \'DELETE\''];

describe('TUI architecture protection', () => {
  it('has source files to protect', () => {
    expect(TUI_FILES.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_IMPORTS)('no TUI file references %s', (token) => {
    const offenders = TUI_FILES.filter((f) => hasRealReference(readFileSync(f, 'utf8'), token));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('issues no mutating HTTP requests', () => {
    const offenders = TUI_FILES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return FORBIDDEN_METHODS.some((m) => src.includes(m));
    });
    expect(offenders.map(rel)).toEqual([]);
  });
});
