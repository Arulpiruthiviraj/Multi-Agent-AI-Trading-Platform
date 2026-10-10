/**
 * DB SCHEMA vs MIGRATIONS consistency (static analysis - cross-cutting defect hunt).
 *
 * Replays every drizzle/*.sql migration in order (CREATE TABLE [IF NOT EXISTS],
 * ALTER TABLE ADD/DROP/RENAME COLUMN, table RENAME TO, DROP TABLE - including the
 * SQLite __new_<table> rebuild pattern) to compute the FINAL table->column map,
 * then asserts src/server/db/schema.ts's sqliteTable definitions match it exactly
 * in both directions:
 *
 *  1. Every schema.ts table exists in the migrated final state (catches a table
 *     added to schema.ts without a migration - code would write to a table that
 *     never gets created on a fresh DB).
 *  2. Every migrated table exists in schema.ts (catches a migration whose table
 *     the code can no longer see).
 *  3. Column sets match per table in both directions (catches renamed/dropped
 *     columns the code still references, and migration columns the code ignores).
 *  4. Raw-SQL table references in src (FROM/INTO/UPDATE outside tests) resolve to
 *     a schema table, a SQLite system table, or a declared external-DB exclusion.
 *
 * Pure text parsing - never opens a database, never touches the trading path.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DRIZZLE_DIR = path.join(REPO_ROOT, 'drizzle');
const SCHEMA_PATH = path.join(REPO_ROOT, 'src/server/db/schema.ts');

/** Tables read from a DIFFERENT database file, not Argus's own SQLite DB. */
const EXTERNAL_DB_TABLES = new Set([
  'unified_cache', // Fincept Terminal's own cache.db (FinceptCacheAdapter, read-only)
]);
/** SQLite / drizzle internals, not Argus tables. */
const SYSTEM_TABLES = new Set(['sqlite_master', 'sqlite_sequence', '__drizzle_migrations']);

const Q = '[`"]?';

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function parseColumnNames(createBody: string): Set<string> {
  const cols = new Set<string>();
  for (const rawLine of createBody.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    // Skip table constraints. \b-guarded: a column named primary_fate must NOT match.
    if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)(\s|\()/i.test(line)) continue;
    const m = line.match(new RegExp(`^${Q}(\\w+)${Q}\\s+([a-zA-Z]+)`));
    if (m) cols.add(m[1]);
  }
  return cols;
}

interface MigrationEvent {
  pos: number;
  kind: 'create' | 'addcol' | 'dropcol' | 'renamecol' | 'renametable' | 'droptable';
  table: string;
  extra?: Set<string> | string | [string, string];
}

/** Replay all migrations in filename order; return final table -> columns. */
function replayMigrations(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = fs.readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const sql = stripComments(fs.readFileSync(path.join(DRIZZLE_DIR, file), 'utf8'));
    const events: MigrationEvent[] = [];
    const push = (e: MigrationEvent) => events.push(e);
    for (const m of sql.matchAll(
      new RegExp(`CREATE TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${Q}(\\w+)${Q}\\s*\\(([\\s\\S]*?)\\);`, 'gi'),
    )) {
      push({ pos: m.index!, kind: 'create', table: m[1], extra: parseColumnNames(m[2]) });
    }
    for (const m of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+${Q}(\\w+)${Q}\\s+ADD\\s+(?:COLUMN\\s+)?${Q}(\\w+)${Q}`, 'gi'),
    )) {
      push({ pos: m.index!, kind: 'addcol', table: m[1], extra: m[2] });
    }
    for (const m of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+${Q}(\\w+)${Q}\\s+DROP\\s+COLUMN\\s+${Q}(\\w+)${Q}`, 'gi'),
    )) {
      push({ pos: m.index!, kind: 'dropcol', table: m[1], extra: m[2] });
    }
    for (const m of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+${Q}(\\w+)${Q}\\s+RENAME\\s+COLUMN\\s+${Q}(\\w+)${Q}\\s+TO\\s+${Q}(\\w+)${Q}`, 'gi'),
    )) {
      push({ pos: m.index!, kind: 'renamecol', table: m[1], extra: [m[2], m[3]] as [string, string] });
    }
    for (const m of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+${Q}(\\w+)${Q}\\s+RENAME\\s+TO\\s+${Q}(\\w+)${Q}`, 'gi'),
    )) {
      // Exclude the RENAME COLUMN case already captured above.
      const between = m[0].toUpperCase().split('RENAME')[1].split('TO')[0];
      if (!between.includes('COLUMN')) push({ pos: m.index!, kind: 'renametable', table: m[1], extra: m[2] });
    }
    for (const m of sql.matchAll(
      new RegExp(`DROP TABLE\\s+(?:IF\\s+EXISTS\\s+)?${Q}(\\w+)${Q}`, 'gi'),
    )) {
      push({ pos: m.index!, kind: 'droptable', table: m[1] });
    }
    for (const e of events.sort((a, b) => a.pos - b.pos)) {
      if (e.kind === 'create') tables.set(e.table, new Set(e.extra as Set<string>));
      else if (e.kind === 'addcol') {
        if (!tables.has(e.table)) tables.set(e.table, new Set());
        tables.get(e.table)!.add(e.extra as string);
      } else if (e.kind === 'dropcol') tables.get(e.table)?.delete(e.extra as string);
      else if (e.kind === 'renamecol') {
        const [from, to] = e.extra as [string, string];
        tables.get(e.table)?.delete(from);
        if (!tables.has(e.table)) tables.set(e.table, new Set());
        tables.get(e.table)!.add(to);
      } else if (e.kind === 'renametable') {
        const cols = tables.get(e.table);
        if (cols) {
          tables.delete(e.table);
          tables.set(e.extra as string, cols);
        }
      } else if (e.kind === 'droptable') tables.delete(e.table);
    }
  }
  return tables;
}

/** Parse schema.ts sqliteTable('name', { jsKey: type('db_col') }) -> table -> DB column names. */
function parseSchemaTables(): Map<string, Set<string>> {
  const src = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const tables = new Map<string, Set<string>>();
  for (const m of src.matchAll(/sqliteTable\(\s*["'](\w+)["']\s*,\s*\{([\s\S]*?)\n\}\s*\)/g)) {
    const cols = new Set<string>();
    for (const cm of m[2].matchAll(/:\s*(?:integer|text|real|blob|numeric)\(\s*["'](\w+)["']/g)) {
      cols.add(cm[1]);
    }
    tables.set(m[1], cols);
  }
  return tables;
}

/** Raw-SQL table references (FROM/INTO/UPDATE/JOIN) in non-test src files.
 *  Only string literals that actually contain SQL (SELECT/INSERT/UPDATE/DELETE)
 *  are scanned, so English prose in comments ("derived from the ...") is ignored. */
function rawSqlTableRefs(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        const src = fs.readFileSync(full, 'utf8');
        // String literals: backtick templates, single/double quotes (non-greedy).
        const literals = src.match(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) ?? [];
        for (const lit of literals) {
          // Real SQL strings in this codebase start with a SQL verb (possibly after
          // whitespace/newline in a template literal). Prose that merely mentions
          // "select"/"update" mid-sentence is ignored.
          const trimmed = lit.replace(/^[`"'\s]+/, '');
          if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH|PRAGMA|CREATE|ALTER|DROP|VACUUM|EXPLAIN)\b/i.test(trimmed)) continue;
          // (?<!DO )UPDATE: "ON CONFLICT(...) DO UPDATE SET" is a SQLite upsert -
          // SET is not a table there.
          for (const m of lit.matchAll(/(?:FROM|INTO|(?<!DO )UPDATE|JOIN)\s+`?([a-z_][a-z0-9_]*)`?/gi)) {
            const t = m[1].toLowerCase();
            if (!refs.has(t)) refs.set(t, []);
            refs.get(t)!.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return refs;
}

describe('schema.ts vs drizzle migrations consistency (static)', () => {
  const migrated = replayMigrations();
  const schemaTables = parseSchemaTables();

  it('parses a non-trivial inventory on both sides (test self-check)', () => {
    expect(migrated.size).toBeGreaterThan(50);
    expect(schemaTables.size).toBeGreaterThan(50);
  });

  it('every schema.ts table exists in the migrated final state', () => {
    const missing = [...schemaTables.keys()].filter((t) => !migrated.has(t));
    expect(missing, 'tables in schema.ts with no migration - fresh DBs would lack them').toEqual([]);
  });

  it('every migrated table exists in schema.ts', () => {
    const missing = [...migrated.keys()].filter((t) => !schemaTables.has(t));
    expect(missing, 'migrated tables invisible to code').toEqual([]);
  });

  it('column sets match per table in both directions', () => {
    const problems: string[] = [];
    for (const [t, scols] of schemaTables) {
      const mcols = migrated.get(t);
      if (!mcols) continue;
      for (const c of scols) if (!mcols.has(c)) problems.push(`${t}.${c} in schema.ts but not in migrations`);
      for (const c of mcols) if (!scols.has(c)) problems.push(`${t}.${c} in migrations but not in schema.ts`);
    }
    expect(problems).toEqual([]);
  });

  it('raw-SQL table references resolve to a known table', () => {
    const unknown: string[] = [];
    for (const [t, files] of rawSqlTableRefs()) {
      if (schemaTables.has(t) || SYSTEM_TABLES.has(t) || EXTERNAL_DB_TABLES.has(t)) continue;
      unknown.push(`${t} (referenced by ${files.slice(0, 3).join(', ')})`);
    }
    expect(unknown, 'raw SQL references to unknown tables').toEqual([]);
  });
});
