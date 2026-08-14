/**
 * ==========================================================
 * Script: scan_unallowlisted_writes.ts
 *
 * Purpose:
 * Phase 4C of FINAL_ANALYSIS.md's 4-phase remediation plan. Scans every Express route file for
 * the exact bug pattern this engagement has found and fixed multiple separate times, in
 * different routes, discovered only by someone deliberately going looking each time (Sections
 * 16, 22.3, 23.4): a raw, unvalidated `req.body` (or a spread of it) written directly into a
 * `db.insert()`/`db.update().set()` call, bypassing whatever field allowlist the route is
 * supposed to enforce. Real past instances this exact pattern would have caught:
 *   - `db.insert(schema.settings).values(req.body)` (Section 16, before the SETTINGS_ALLOWED_FIELDS fix)
 *   - `db.insert(schema.brokerConnections).values({ brokerName, ...rest })` where `rest` still
 *     included `paperMode` from the raw body (Section 22.3, before it was destructured out)
 *
 * Scope, stated honestly: this is a real, useful heuristic line-scanner, not a full data-flow
 * analyzer. It catches `req.body` (or `...req.body`) used DIRECTLY inside `.values(`/`.set(` -
 * exactly the shape every real instance found so far has taken. It will NOT catch a case where
 * `req.body` is first aliased to a differently-named variable further from the write call (e.g.
 * `const raw = req.body; ...later... .values(raw)`) - a genuine limitation of line-level
 * pattern matching, disclosed here rather than silently overclaiming full coverage.
 *
 * Usage: `npm run security:scan-writes` - exits 1 (and lists every finding) if anything matches,
 * exits 0 if clean. Suitable as a CI gate.
 * ==========================================================
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROUTE_DIRS = ['src/server/routes'];
const ROUTE_FILES = ['server.ts'];
const FILE_EXTENSIONS = ['.ts'];
const EXCLUDE_SUFFIXES = ['.test.ts'];

export interface Finding {
  file: string;
  line: number;
  snippet: string;
  pattern: string;
}

// Each pattern targets req.body (or a spread of it) landing directly inside a Drizzle
// .values(...)/.set(...) call, or a raw Object.assign onto shared mutable state - the two real
// shapes every instance of this bug has taken in this codebase so far. `anchor` must match the
// line where the call syntactically STARTS (there is exactly one such line per real call site) -
// used to decide which single line to build a lookahead window from, so a real multi-line call
// is reported exactly once, not once per overlapping window position that happens to see it.
const DANGEROUS_PATTERNS: { name: string; anchor: RegExp; full: RegExp }[] = [
  { name: 'insert/update .values(req.body) - direct, unfiltered', anchor: /\.values\(/, full: /\.values\(\s*req\.body\s*\)/ },
  { name: 'insert/update .values({ ...req.body ... }) - spread of the raw body', anchor: /\.values\(/, full: /\.values\(\s*\{[^}]*\.\.\.req\.body/ },
  { name: '.set(req.body) - direct, unfiltered update', anchor: /\.set\(/, full: /\.set\(\s*req\.body\s*\)/ },
  { name: '.set({ ...req.body ... }) - spread of the raw body into an update', anchor: /\.set\(/, full: /\.set\(\s*\{[^}]*\.\.\.req\.body/ },
  { name: 'Object.assign(state, req.body) - unfiltered mutation of shared state', anchor: /Object\.assign\(/, full: /Object\.assign\([^,]+,\s*req\.body\s*\)/ },
];

function collectFiles(): string[] {
  const files: string[] = [];
  for (const dir of ROUTE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (FILE_EXTENSIONS.some(ext => entry.endsWith(ext)) && !EXCLUDE_SUFFIXES.some(s => entry.endsWith(s))) {
        files.push(path.join(dir, entry));
      }
    }
  }
  for (const f of ROUTE_FILES) {
    if (fs.existsSync(f)) files.push(f);
  }
  return files;
}

export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

export function scanLines(lines: string[], filePath = '(inline)'): Finding[] {
  const findings: Finding[] = [];
  // Multi-line .values({...}) calls need a small sliding window, not just one line at a time -
  // join each line with the next few so a spread on line N+1 of a call opened on line N is seen.
  // Comment lines are excluded from the window entirely - a real past instance of this pattern
  // documented in a code comment (e.g. explaining what a fixed bug used to look like) must never
  // be flagged as if it were live code.
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    for (const { name, anchor, full } of DANGEROUS_PATTERNS) {
      if (!anchor.test(lines[i])) continue;
      const window = lines.slice(i, i + 4).filter(l => !isCommentLine(l)).join(' ');
      if (full.test(window)) {
        findings.push({ file: filePath, line: i + 1, snippet: lines[i].trim(), pattern: name });
      }
    }
  }
  return findings;
}

function scanFileOnDisk(filePath: string): Finding[] {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  return scanLines(lines, filePath);
}

function main() {
  const files = collectFiles();
  const allFindings: Finding[] = [];
  for (const file of files) {
    allFindings.push(...scanFileOnDisk(file));
  }

  if (allFindings.length === 0) {
    console.log(`[scan_unallowlisted_writes] Scanned ${files.length} route file(s). No raw req.body writes found. Clean.`);
    process.exit(0);
  }

  console.error(`[scan_unallowlisted_writes] Found ${allFindings.length} potential un-allowlisted write path(s):\n`);
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}  [${f.pattern}]\n    ${f.snippet}\n`);
  }
  console.error('Each of these should either allowlist specific fields before writing, or be reviewed and explicitly exempted if it is genuinely safe (e.g. an already-destructured/filtered body).');
  process.exit(1);
}

// Only run as a CLI when executed directly (`tsx scripts/scan_unallowlisted_writes.ts`) - never
// when imported as a module (e.g. by this script's own unit tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
