/**
 * OFFLINE-FORENSIC / RESEARCH-ONLY. Full (not sampled) streaming pass over a .heapsnapshot file's
 * "strings" table, classifying every string into a content category via cheap regex heuristics and
 * tallying count + total char length per category (O(1) memory - never holds more than a few
 * example strings per category). Built 2026-09-14 to answer the specific question the operator
 * raised: the preserved P1-B incident snapshot has 18.27M string nodes dominating self_size, while
 * the isolated reproduction harness's snapshots show far fewer, much smaller strings - what content
 * *category* actually accounts for the incident's string volume (trace IDs? timestamps? reasoning
 * text? serialized payloads? cache keys? something else)?
 *
 * Never mutates, never runs inside the trading process, never takes a new live snapshot - reads an
 * already-captured file only.
 *
 * Usage: node --max-old-space-size=512 scripts/forensic/categorize_heap_snapshot_strings.mjs <path>
 */
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';

const FILE = process.argv[2];
if (!FILE) {
  console.error('Usage: node categorize_heap_snapshot_strings.mjs <path-to-.heapsnapshot>');
  process.exit(1);
}

const EXAMPLES_PER_CATEGORY = 3;
const EXAMPLE_MAX_CHARS = 160;

// Order matters - first matching category wins.
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
  for (const c of CATEGORIES) {
    if (c.test(s)) return c.name;
  }
  return 'other';
}

const stats = new Map(); // category -> { count, totalChars, examples: [], minLen, maxLen }
function record(category, s) {
  let st = stats.get(category);
  if (!st) {
    st = { count: 0, totalChars: 0, examples: [], minLen: Infinity, maxLen: 0 };
    stats.set(category, st);
  }
  st.count++;
  st.totalChars += s.length;
  if (s.length < st.minLen) st.minLen = s.length;
  if (s.length > st.maxLen) st.maxLen = s.length;
  if (st.examples.length < EXAMPLES_PER_CATEGORY) {
    st.examples.push(s.length > EXAMPLE_MAX_CHARS ? s.slice(0, EXAMPLE_MAX_CHARS) + '…' : s);
  }
}

async function main() {
  const fileSizeMb = (statSync(FILE).size / (1024 * 1024)).toFixed(1);
  console.log(`Reading ${FILE} (${fileSizeMb}MB) ...`);
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const stream = createReadStream(FILE, { encoding: 'utf8', highWaterMark: 4 << 20 });
    let carry = '';
    let started = false;
    let totalStrings = 0;
    let inString = false;
    let escapeNext = false;
    let curStr = '';
    let curLen = 0; // track length without necessarily materializing very long strings fully in a hot loop

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
          if (ch === '"') { inString = true; curStr = ''; curLen = 0; }
          continue;
        }
        if (escapeNext) {
          // Keep escapes cheap: unescape only the common cases enough for classification;
          // exactness doesn't matter for category regex purposes.
          curStr += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
          curLen++;
          escapeNext = false;
          continue;
        }
        if (ch === '\\') { escapeNext = true; continue; }
        if (ch === '"') {
          inString = false;
          totalStrings++;
          record(classify(curStr), curStr);
          continue;
        }
        curStr += ch;
        curLen++;
      }
    });
    stream.on('close', () => { console.log(`\nTotal strings parsed: ${totalStrings.toLocaleString()} (${Date.now() - startedAt}ms)`); resolve(); });
    stream.on('error', reject);
  });

  const rows = [...stats.entries()].sort((a, b) => b[1].totalChars - a[1].totalChars);
  const grandTotalChars = rows.reduce((s, [, v]) => s + v.totalChars, 0);
  const grandTotalCount = rows.reduce((s, [, v]) => s + v.count, 0);

  console.log('\n=== Category breakdown (sorted by total char volume) ===\n');
  for (const [name, st] of rows) {
    const pctChars = ((st.totalChars / grandTotalChars) * 100).toFixed(1);
    const pctCount = ((st.count / grandTotalCount) * 100).toFixed(1);
    console.log(`${name.padEnd(24)} count=${st.count.toLocaleString().padStart(10)} (${pctCount.padStart(5)}%)  chars=${st.totalChars.toLocaleString().padStart(12)} (${pctChars.padStart(5)}%)  avgLen=${(st.totalChars / st.count).toFixed(1).padStart(7)}  len[${st.minLen}-${st.maxLen}]`);
    for (const ex of st.examples) console.log(`    e.g. ${JSON.stringify(ex)}`);
  }
  console.log(`\nGrand total: ${grandTotalCount.toLocaleString()} strings, ${grandTotalChars.toLocaleString()} chars`);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
