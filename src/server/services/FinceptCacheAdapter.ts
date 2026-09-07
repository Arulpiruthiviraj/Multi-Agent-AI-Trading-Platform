/**
 * ==========================================================
 * Module: FinceptCacheAdapter.ts
 *
 * Read-only advisory bridge to a locally-running Fincept Terminal (a separate,
 * untrusted sibling desktop app - see CLAUDE.md's "Sibling engines... untrusted,
 * read-only" rule). Reads ONLY Fincept's generic `unified_cache` key/value table
 * in its `cache.db` SQLite file, never `fincept.db` (which carries real
 * credential/connection-secret tables - confirmed by direct schema inspection
 * during the 2026-09-07 integration investigation).
 *
 * Real ground truth this was built against (not a guide, not a relayed prompt -
 * verified directly this session):
 * - Fincept's only genuine external-facing surface, TerminalMcpBridge, binds an
 *   OS-assigned ephemeral port and mints a fresh, never-persisted auth token on
 *   every launch - by design, for its own bundled Python subprocess only. There
 *   is no supported way for an external process to reach it.
 * - `cache.db`'s `unified_cache` table IS real and has no credential columns,
 *   but it is far more transient than a "live feed": keys like `market:^VIX`
 *   only exist while Fincept's own UI is actively displaying that data (e.g. a
 *   market-watch screen open) and are evicted once it isn't - confirmed live
 *   this session: the table went from 57 populated rows to zero within
 *   minutes, with no code change on either side. This adapter's fail-silent,
 *   return-null design is therefore the normal case, not an edge case - expect
 *   this to come back empty most of the time, and never treat that as a bug.
 * - The exact JSON shape of a `market:*` value was NOT empirically confirmed
 *   (the table was empty every time this was re-checked). extractPriceAndChangePct()
 *   below defensively tries several common quote-API field names (plain
 *   price/changePct, and Yahoo-Finance-style regularMarketPrice/
 *   regularMarketChangePercent, since the product literature lists Yahoo
 *   Finance as a data connector) rather than asserting one - if the real shape
 *   differs, this fails to null exactly like every other unrecognized case,
 *   never a crash or a fabricated number.
 *
 * Safety invariants (do not weaken):
 * - Read-only SQLite connection (`readonly: true`). Never writes.
 * - Hardcoded to query ONLY the `unified_cache` table by a fixed, parameterized
 *   key - never a dynamic table name, never `fincept.db`.
 * - Honors Fincept's own `expires_at` - an expired cache row is treated exactly
 *   like a missing one, never served as if fresh (same "never trade/reason on
 *   stale data" principle as gate 13 / waitForFreshMarketData.ts elsewhere in
 *   this codebase).
 * - Fails closed and silent on every error path (missing file, locked file,
 *   malformed JSON, missing key) - returns null, never throws to the caller,
 *   never blocks the caller's own tick.
 * - Advisory only: the caller (MacroAgent) may only fold this into reasoning
 *   TEXT. It must never influence confidence, side, or reach RiskEngine/OMS -
 *   identical contract to `learnedRulesText` / the Java quant debate-context
 *   injection already reviewed in ChiefTraderAgent.ts.
 * ==========================================================
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { isRuntimeFlagEnabled } from '../config/effectiveRuntimeConfig';

export interface FinceptMacroSnapshot {
  vix: number | null;
  indices: Record<string, { price: number | null; changePct: number | null }>;
  asOfMs: number;
}

const TRACKED_INDEX_KEYS: Record<string, string> = {
  '^GSPC': 'S&P 500',
  '^DJI': 'Dow Jones',
  '^IXIC': 'Nasdaq',
  '^RUT': 'Russell 2000',
};
const VIX_KEY = '^VIX';

function defaultCacheDbPath(): string {
  // Fincept Terminal (v4/v5, Qt6/C++20 build) is Windows-only in this deployment
  // today - confirmed via the running process's real install path
  // (C:\Program Files\FinceptTerminal\FinceptTerminal.exe). This default only
  // needs to be right for that platform; FINCEPT_CACHE_DB_PATH overrides it.
  return path.join(os.homedir(), 'AppData', 'Local', 'com.fincept.terminal', 'data', 'cache.db');
}

function resolveCacheDbPath(): string {
  const override = process.env.FINCEPT_CACHE_DB_PATH?.trim();
  return override && override.length > 0 ? override : defaultCacheDbPath();
}

interface RawCacheRow {
  value: string;
  expires_at: number | null;
}

/** Reads one `unified_cache` row by exact key. Never throws - a failure here is
 *  exactly as "unavailable" as Fincept not running at all. */
function readCacheKey(key: string): unknown | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(resolveCacheDbPath(), { readonly: true, fileMustExist: true });
    const row = db
      .prepare(`SELECT value, expires_at FROM unified_cache WHERE key = ?`)
      .get(key) as RawCacheRow | undefined;
    if (!row) return null;
    if (typeof row.expires_at === 'number' && Date.now() > row.expires_at) return null; // stale - treat as absent
    try {
      return JSON.parse(row.value);
    } catch {
      return null; // malformed cache value - never guess at its shape
    }
  } catch {
    return null; // file missing / locked / not a Fincept cache.db at all
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

function extractPriceAndChangePct(raw: any): { price: number | null; changePct: number | null } {
  const price = typeof raw?.price === 'number' ? raw.price
    : typeof raw?.regularMarketPrice === 'number' ? raw.regularMarketPrice
    : typeof raw?.last === 'number' ? raw.last
    : null;
  const changePct = typeof raw?.changePct === 'number' ? raw.changePct
    : typeof raw?.regularMarketChangePercent === 'number' ? raw.regularMarketChangePercent
    : typeof raw?.changePercent === 'number' ? raw.changePercent
    : null;
  return { price, changePct };
}

/** Bounded, cheap: reads exactly 5 known keys (VIX + 4 major indices), never
 *  the whole table and never the (large) news blob. Returns null - and MacroAgent
 *  must proceed exactly as if this function did not exist - unless the feature
 *  flag is on AND Fincept's cache genuinely has fresh data right now. */
export function getFinceptMacroSnapshot(): FinceptMacroSnapshot | null {
  if (!isRuntimeFlagEnabled('ENABLE_FINCEPT_CACHE_ADVISORY')) return null;

  const vixRaw = readCacheKey(`market:${VIX_KEY}`);
  const vix = vixRaw != null ? extractPriceAndChangePct(vixRaw).price : null;

  const indices: FinceptMacroSnapshot['indices'] = {};
  let sawAny = vix != null;
  for (const [key, label] of Object.entries(TRACKED_INDEX_KEYS)) {
    const raw = readCacheKey(`market:${key}`);
    if (raw == null) continue;
    indices[label] = extractPriceAndChangePct(raw);
    sawAny = true;
  }

  if (!sawAny) return null; // Fincept not running / cache empty - nothing to attach
  return { vix, indices, asOfMs: Date.now() };
}

/** Short, human-readable line MacroAgent may append to its prompt/reasoning as
 *  supplementary, clearly-attributed, non-authoritative context. Never asserts
 *  a recommendation - just states the numbers. */
export function formatFinceptMacroSnapshotForPrompt(snapshot: FinceptMacroSnapshot): string {
  const parts: string[] = [];
  if (snapshot.vix != null) parts.push(`VIX ${snapshot.vix.toFixed(2)}`);
  for (const [label, v] of Object.entries(snapshot.indices)) {
    if (v.price == null) continue;
    const chg = v.changePct != null ? ` (${v.changePct >= 0 ? '+' : ''}${v.changePct.toFixed(2)}%)` : '';
    parts.push(`${label} ${v.price.toFixed(2)}${chg}`);
  }
  return parts.length > 0 ? `Fincept Terminal supplementary context (read-only, advisory): ${parts.join(', ')}.` : '';
}
