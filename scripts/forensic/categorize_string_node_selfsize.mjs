/**
 * OFFLINE-FORENSIC / RESEARCH-ONLY. Two-pass streaming cross-reference, O(1) memory w.r.t. file
 * size (the only thing held across passes is a small per-string-table-entry category id, ~1 byte
 * x table size - for the real incident file that's under 1MB, not the multi-GB file itself).
 *
 * Built 2026-09-14 because categorize_heap_snapshot_strings.mjs answered "what does the UNIQUE
 * string content look like" (649,013 distinct entries in the incident snapshot's `strings` table)
 * but NOT "which content category accounts for the 18.27M `string`-TYPE NODES / 861MB self_size"
 * that analyze_heap_snapshot.mjs found - those two numbers differ by ~28x, meaning a relatively
 * small set of distinct string VALUES are each referenced by many separate live String node
 * instances. This script resolves that: for every `string`-type node, look up its underlying
 * content's category (via the node's `name` field, a strings-table index) and tally real self_size
 * by category - the direct answer to "what production data/object path creates millions of
 * retained strings."
 *
 * Pass 1: stream the `strings` table, classify each entry (same heuristics as
 *         categorize_heap_snapshot_strings.mjs), store ONLY a category id per index.
 * Pass 2: stream the `nodes` array (same parser as analyze_heap_snapshot.mjs), for every
 *         type===string node look up categoryByStringIndex[node.name] and accumulate selfSize.
 *
 * Usage: node --max-old-space-size=1024 scripts/forensic/categorize_string_node_selfsize.mjs <path>
 * (slightly higher cap than the other two scripts since pass 1 holds one small Uint8Array sized to
 * the strings-table length - still nowhere near the snapshot file's own size.)
 */
import { createReadStream, statSync } from 'node:fs';

const FILE = process.argv[2];
if (!FILE) {
  console.error('Usage: node categorize_string_node_selfsize.mjs <path-to-.heapsnapshot>');
  process.exit(1);
}

const NODE_TYPES = ["hidden","array","string","object","code","closure","regexp","number","native","synthetic","concatenated string","sliced string","symbol","bigint","object shape"];
const STRING_TYPE_INDEX = NODE_TYPES.indexOf('string');

const CATEGORIES = [
  { name: 'traceId', test: (s) => /^trace_[A-Za-z0-9.]+_\d{9,}_[a-f0-9]{3,}$/i.test(s) },
  { name: 'isoTimestamp', test: (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) },
  { name: 'uuid', test: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) },
  { name: 'jsonLikePayload', test: (s) => s.length > 10 && ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']')) },
  { name: 'errorOrDiagnostic', test: (s) => /error|exception|fail(ed)?|traceback|\bat\s+\S+\s*\(/i.test(s) && s.length > 15 },
  { name: 'reasoningOrDebateText', test: (s) => s.length > 60 && /RSI|MACD|Bollinger|confidence|forecast|momentum|oversold|overbought|support|resistance|Chronos|sentiment|trend|consensus|debate|reasoning|breakout|volatility/i.test(s) },
  { name: 'tickerSymbolLike', test: (s) => /^[A-Z]{1,5}$/.test(s) },
  { name: 'compositeCacheKeyLike', test: (s) => /^[\w.-]+[:_][\w.:_-]+$/.test(s) && s.length <= 200 && (s.match(/[:_]/g) || []).length >= 2 },
  { name: 'numericString', test: (s) => /^-?\d+(\.\d+)?$/.test(s) },
  { name: 'empty', test: (s) => s.length === 0 },
  { name: 'shortIdentifier', test: (s) => s.length <= 40 && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(s) },
];
function classify(s) {
  for (const c of CATEGORIES) if (c.test(s)) return c.name;
  return 'other';
}

async function readHeader(file) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start: 0, end: 4095, encoding: 'utf8' });
    let buf = '';
    stream.on('data', (c) => { buf += c; });
    stream.on('end', () => {
      const m = buf.match(/"node_count":(\d+),"edge_count":(\d+)/);
      if (!m) return reject(new Error('could not find node_count/edge_count in header'));
      resolve({ nodeCount: Number(m[1]), edgeCount: Number(m[2]) });
    });
    stream.on('error', reject);
  });
}

// Pass 1: classify the strings table in order, return an array of category names by index.
async function classifyStringsTable(file) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 4 << 20 });
    let carry = '';
    let started = false;
    let inString = false;
    let escapeNext = false;
    let curStr = '';
    const categories = [];

    stream.on('data', (chunk) => {
      let text = carry + chunk;
      carry = '';
      if (!started) {
        const marker = '"strings":[';
        const idx = text.lastIndexOf(marker);
        if (idx === -1) { carry = text.slice(-marker.length); return; }
        text = text.slice(idx + marker.length);
        started = true;
      }
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!inString) {
          if (ch === '"') { inString = true; curStr = ''; }
          continue;
        }
        if (escapeNext) { curStr += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch; escapeNext = false; continue; }
        if (ch === '\\') { escapeNext = true; continue; }
        if (ch === '"') { inString = false; categories.push(classify(curStr)); continue; }
        curStr += ch;
      }
    });
    stream.on('close', () => resolve(categories));
    stream.on('error', reject);
  });
}

// Pass 2: stream nodes, resolve type===string nodes' category via the lookup, tally self_size.
async function tallyStringNodeSelfSize(file, nodeCount, categoryByIndex) {
  const NODE_FIELDS = 6; // type,name,id,self_size,edge_count,detachedness - matches analyze_heap_snapshot.mjs
  const totalInts = nodeCount * NODE_FIELDS;
  const bySelfSize = new Map();
  const record = (cat, selfSize) => {
    let e = bySelfSize.get(cat);
    if (!e) { e = { count: 0, selfSize: 0 }; bySelfSize.set(cat, e); }
    e.count++;
    e.selfSize += selfSize;
  };

  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let carry = '';
    let started = false;
    let intsParsed = 0;
    const fieldBuf = new Array(NODE_FIELDS);
    let fieldIdx = 0;
    let nodesParsed = 0;
    let stringNodesResolved = 0;
    let stringNodesOutOfRange = 0;

    stream.on('data', (chunk) => {
      if (intsParsed >= totalInts) return;
      let text = carry + chunk;
      if (!started) {
        const marker = '"nodes":[';
        const idx = text.indexOf(marker);
        if (idx === -1) { carry = text.slice(-marker.length); return; }
        text = text.slice(idx + marker.length);
        started = true;
      }
      let numStart = 0;
      for (let i = 0; i < text.length && intsParsed < totalInts; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 44 /* , */) {
          const tok = text.slice(numStart, i);
          if (tok.length > 0) {
            fieldBuf[fieldIdx++] = Number(tok);
            intsParsed++;
            if (fieldIdx === NODE_FIELDS) {
              const [type, name, , selfSize] = fieldBuf;
              nodesParsed++;
              if (type === STRING_TYPE_INDEX) {
                const cat = categoryByIndex[name];
                if (cat !== undefined) { record(cat, selfSize); stringNodesResolved++; }
                else { record('__unresolved_index__', selfSize); stringNodesOutOfRange++; }
              }
              fieldIdx = 0;
            }
          }
          numStart = i + 1;
        }
      }
      carry = text.slice(numStart, text.length);
      if (intsParsed >= totalInts) { stream.destroy(); resolve({ nodesParsed, stringNodesResolved, stringNodesOutOfRange, bySelfSize }); }
    });
    stream.on('close', () => resolve({ nodesParsed, stringNodesResolved, stringNodesOutOfRange, bySelfSize }));
    stream.on('error', reject);
  });
}

async function main() {
  const fileSizeMb = (statSync(FILE).size / (1024 * 1024)).toFixed(1);
  console.log(`File: ${FILE} (${fileSizeMb}MB)`);
  const { nodeCount } = await readHeader(FILE);
  console.log(`node_count=${nodeCount}`);

  console.log('\nPass 1: classifying strings table ...');
  const t1 = Date.now();
  const categoryByIndex = await classifyStringsTable(FILE);
  console.log(`strings table entries: ${categoryByIndex.length.toLocaleString()} (${Date.now() - t1}ms)`);

  console.log('\nPass 2: streaming nodes, resolving string-type node self_size by category ...');
  const t2 = Date.now();
  const { nodesParsed, stringNodesResolved, stringNodesOutOfRange, bySelfSize } =
    await tallyStringNodeSelfSize(FILE, nodeCount, categoryByIndex);
  console.log(`nodes parsed: ${nodesParsed.toLocaleString()} | string-type nodes resolved: ${stringNodesResolved.toLocaleString()} | unresolved: ${stringNodesOutOfRange.toLocaleString()} (${Date.now() - t2}ms)`);

  const rows = [...bySelfSize.entries()].sort((a, b) => b[1].selfSize - a[1].selfSize);
  const totalSelfSize = rows.reduce((s, [, v]) => s + v.selfSize, 0);
  console.log('\n=== string-type NODE self_size by content category (sorted) ===\n');
  for (const [name, v] of rows) {
    const pct = ((v.selfSize / totalSelfSize) * 100).toFixed(1);
    console.log(`${name.padEnd(24)} count=${v.count.toLocaleString().padStart(12)}  selfSize=${(v.selfSize / (1024 * 1024)).toFixed(1).padStart(9)}MB (${pct.padStart(5)}%)  avgBytes/node=${(v.selfSize / v.count).toFixed(1)}`);
  }
  console.log(`\nTotal string-type node self_size: ${(totalSelfSize / (1024 * 1024)).toFixed(1)}MB across ${rows.reduce((s, [, v]) => s + v.count, 0).toLocaleString()} nodes`);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
