/**
 * OFFLINE-FORENSIC / RESEARCH-ONLY. Bounded retainer-path SAMPLE for a .heapsnapshot file.
 * Never loads the file into a graph tool (Chrome DevTools on a 2GB file can need 5-10x RAM to
 * build its full object model - real risk on this host); instead does 3 bounded streaming passes,
 * each O(1) memory w.r.t. file size (the only cross-pass state is a handful of typed arrays sized
 * to node_count, not file size - ~270MB for a 30M-node file, well under the process cap).
 *
 * Built 2026-09-14 as the direct follow-up to categorize_string_node_selfsize.mjs's finding: the
 * incident snapshot has only 649,013 distinct string-table entries but 18,271,808 live `string`-type
 * NODES - a ~28x average duplication ratio (719x for the tickerSymbolLike/short-enum category
 * specifically, 143x for reasoningOrDebateText). This answers "who is holding the extra copies":
 *
 * Pass A: classify + store the full strings table content (small - ~22MB of chars for this file).
 * Pass B: stream `nodes`, building per-node arrays (type, nameIndex, edgeCount) AND, for `string`
 *         nodes whose content matches one of the chosen target values, tally an occurrence count
 *         and grab a small bounded sample of their node indices (the specific live instances we'll
 *         trace retainers for).
 * Pass C: stream `edges` (using Pass B's per-node edgeCount to know each node's owned edge range,
 *         since V8 heap snapshots group edges by owning node rather than storing an explicit "from"
 *         field), recording every edge whose to_node lands on one of our sampled target node
 *         instances - the OWNING node at that point in the walk is the direct retainer.
 *
 * Usage: node --max-old-space-size=2048 scripts/forensic/retainer_sample.mjs <path> [topN=3]
 * (topN = how many of the most-duplicated distinct values per target category to sample)
 */
import { createReadStream, statSync } from 'node:fs';

const FILE = process.argv[2];
const TOP_N_PER_CATEGORY = Number(process.argv[3] || '3');
const SAMPLES_PER_VALUE = 5; // bounded number of live instances to trace per chosen value
if (!FILE) { console.error('Usage: node retainer_sample.mjs <path> [topN]'); process.exit(1); }

const NODE_TYPES = ["hidden","array","string","object","code","closure","regexp","number","native","synthetic","concatenated string","sliced string","symbol","bigint","object shape"];
const EDGE_TYPES = ["context","element","property","internal","hidden","shortcut","weak"];
const STRING_TYPE_INDEX = NODE_TYPES.indexOf('string');
const TARGET_CATEGORIES = ['tickerSymbolLike', 'reasoningOrDebateText', 'uuid'];

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
      if (!m) return reject(new Error('could not find node_count/edge_count'));
      resolve({ nodeCount: Number(m[1]), edgeCount: Number(m[2]) });
    });
    stream.on('error', reject);
  });
}

// Pass A: full strings table content (small enough to hold in full - it's char content, not the file).
async function loadStringsTable(file) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 4 << 20 });
    let carry = '', started = false, inString = false, escapeNext = false, curStr = '';
    const table = [];
    stream.on('data', (chunk) => {
      let text = carry + chunk; carry = '';
      if (!started) {
        const idx = text.lastIndexOf('"strings":[');
        if (idx === -1) { carry = text.slice(-'"strings":['.length); return; }
        text = text.slice(idx + '"strings":['.length); started = true;
      }
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!inString) { if (ch === '"') { inString = true; curStr = ''; } continue; }
        if (escapeNext) { curStr += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch; escapeNext = false; continue; }
        if (ch === '\\') { escapeNext = true; continue; }
        if (ch === '"') { inString = false; table.push(curStr); continue; }
        curStr += ch;
      }
    });
    stream.on('close', () => resolve(table));
    stream.on('error', reject);
  });
}

// Pass B: stream nodes, build per-node type/nameIndex/edgeCount arrays, tally occurrence counts
// for string-type nodes whose content falls in a target category, and grab bounded index samples
// for the top-N most-duplicated distinct values per category.
async function scanNodes(file, nodeCount, stringTable) {
  const NODE_FIELDS = 6;
  const totalInts = nodeCount * NODE_FIELDS;
  const typeArr = new Uint8Array(nodeCount);
  const nameArr = new Int32Array(nodeCount);
  const edgeCountArr = new Uint32Array(nodeCount);
  const occurrenceByStringIndex = new Map(); // stringIndex -> count (only for target-category strings)
  const sampleIndicesByStringIndex = new Map(); // stringIndex -> [nodeIndex,...] bounded

  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let carry = '', started = false, intsParsed = 0;
    const fieldBuf = new Array(NODE_FIELDS);
    let fieldIdx = 0, nodeIndex = 0;

    stream.on('data', (chunk) => {
      if (intsParsed >= totalInts) return;
      let text = carry + chunk;
      if (!started) {
        const idx = text.indexOf('"nodes":[');
        if (idx === -1) { carry = text.slice(-'"nodes":['.length); return; }
        text = text.slice(idx + '"nodes":['.length); started = true;
      }
      let numStart = 0;
      for (let i = 0; i < text.length && intsParsed < totalInts; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 44) {
          const tok = text.slice(numStart, i);
          if (tok.length > 0) {
            fieldBuf[fieldIdx++] = Number(tok);
            intsParsed++;
            if (fieldIdx === NODE_FIELDS) {
              const [type, name, , , edgeCount] = fieldBuf;
              typeArr[nodeIndex] = type;
              nameArr[nodeIndex] = name;
              edgeCountArr[nodeIndex] = edgeCount;
              if (type === STRING_TYPE_INDEX) {
                const content = stringTable[name];
                if (content !== undefined) {
                  const cat = classify(content);
                  if (TARGET_CATEGORIES.includes(cat)) {
                    occurrenceByStringIndex.set(name, (occurrenceByStringIndex.get(name) || 0) + 1);
                    let samples = sampleIndicesByStringIndex.get(name);
                    if (!samples) { samples = []; sampleIndicesByStringIndex.set(name, samples); }
                    if (samples.length < SAMPLES_PER_VALUE) samples.push(nodeIndex);
                  }
                }
              }
              nodeIndex++;
              fieldIdx = 0;
            }
          }
          numStart = i + 1;
        }
      }
      carry = text.slice(numStart, text.length);
      if (intsParsed >= totalInts) { stream.destroy(); resolve({ typeArr, nameArr, edgeCountArr, occurrenceByStringIndex, sampleIndicesByStringIndex, nodesParsed: nodeIndex }); }
    });
    stream.on('close', () => resolve({ typeArr, nameArr, edgeCountArr, occurrenceByStringIndex, sampleIndicesByStringIndex, nodesParsed: nodeIndex }));
    stream.on('error', reject);
  });
}

// Pass C: stream edges sequentially, using edgeCountArr to track the current owning node, and
// record every edge landing on one of our target node indices (to_node === targetIndex*NODE_FIELDS).
async function scanEdgesForRetainers(file, edgeCountArr, targetNodeIndices) {
  const NODE_FIELDS = 6;
  const targetToNodeValues = new Map(); // to_node value -> targetNodeIndex
  for (const idx of targetNodeIndices) targetToNodeValues.set(idx * NODE_FIELDS, idx);
  const retainers = []; // { ownerNodeIndex, edgeType, edgeNameOrIndex, targetNodeIndex }

  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let carry = '', started = false;
    const EDGE_FIELDS = 3;
    const fieldBuf = new Array(EDGE_FIELDS);
    let fieldIdx = 0;
    let ownerIndex = 0;
    let remainingForOwner = edgeCountArr[0] || 0;
    while (remainingForOwner === 0 && ownerIndex < edgeCountArr.length - 1) { ownerIndex++; remainingForOwner = edgeCountArr[ownerIndex]; }
    let edgesParsed = 0;
    const totalEdges = edgeCountArr.reduce((s, v) => s + v, 0);

    stream.on('data', (chunk) => {
      if (edgesParsed >= totalEdges) return;
      let text = carry + chunk;
      if (!started) {
        const idx = text.indexOf('"edges":[');
        if (idx === -1) { carry = text.slice(-'"edges":['.length); return; }
        text = text.slice(idx + '"edges":['.length); started = true;
      }
      let numStart = 0;
      for (let i = 0; i < text.length && edgesParsed < totalEdges; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 44) {
          const tok = text.slice(numStart, i);
          if (tok.length > 0) {
            fieldBuf[fieldIdx++] = Number(tok);
            if (fieldIdx === EDGE_FIELDS) {
              const [edgeType, nameOrIndex, toNode] = fieldBuf;
              if (targetToNodeValues.has(toNode)) {
                retainers.push({ ownerNodeIndex: ownerIndex, edgeType, edgeNameOrIndex: nameOrIndex, targetNodeIndex: targetToNodeValues.get(toNode) });
              }
              edgesParsed++;
              remainingForOwner--;
              while (remainingForOwner <= 0 && ownerIndex < edgeCountArr.length - 1) {
                ownerIndex++;
                remainingForOwner = edgeCountArr[ownerIndex];
              }
              fieldIdx = 0;
            }
          }
          numStart = i + 1;
        }
      }
      carry = text.slice(numStart, text.length);
      if (edgesParsed >= totalEdges) { stream.destroy(); resolve({ retainers, edgesParsed }); }
    });
    stream.on('close', () => resolve({ retainers, edgesParsed }));
    stream.on('error', reject);
  });
}

async function main() {
  const fileSizeMb = (statSync(FILE).size / (1024 * 1024)).toFixed(1);
  console.log(`File: ${FILE} (${fileSizeMb}MB)`);
  const { nodeCount, edgeCount } = await readHeader(FILE);
  console.log(`node_count=${nodeCount} edge_count=${edgeCount}`);

  console.log('\nPass A: loading strings table content ...');
  let t = Date.now();
  const stringTable = await loadStringsTable(FILE);
  console.log(`strings table: ${stringTable.length.toLocaleString()} entries (${Date.now() - t}ms)`);

  console.log('\nPass B: scanning nodes (building per-node arrays + target occurrence tallies) ...');
  t = Date.now();
  const { typeArr, nameArr, edgeCountArr, occurrenceByStringIndex, sampleIndicesByStringIndex, nodesParsed } = await scanNodes(FILE, nodeCount, stringTable);
  console.log(`nodes scanned: ${nodesParsed.toLocaleString()} (${Date.now() - t}ms)`);

  // Pick top-N most-duplicated distinct string values per target category.
  const byCategory = new Map(TARGET_CATEGORIES.map((c) => [c, []]));
  for (const [stringIndex, count] of occurrenceByStringIndex.entries()) {
    const content = stringTable[stringIndex];
    const cat = classify(content);
    if (byCategory.has(cat)) byCategory.get(cat).push({ stringIndex, content, count });
  }
  const chosenTargets = []; // { stringIndex, content, count, category, sampleNodeIndices }
  for (const [cat, list] of byCategory.entries()) {
    list.sort((a, b) => b.count - a.count);
    for (const entry of list.slice(0, TOP_N_PER_CATEGORY)) {
      chosenTargets.push({ ...entry, category: cat, sampleNodeIndices: sampleIndicesByStringIndex.get(entry.stringIndex) || [] });
    }
  }
  console.log(`\nChosen ${chosenTargets.length} target values (top ${TOP_N_PER_CATEGORY} per category by live-node duplication count):`);
  for (const tgt of chosenTargets) {
    console.log(`  [${tgt.category}] ${JSON.stringify(tgt.content.slice(0, 80))} -> ${tgt.count.toLocaleString()} live node instances, sampling ${tgt.sampleNodeIndices.length}`);
  }

  const allSampleIndices = chosenTargets.flatMap((t) => t.sampleNodeIndices);
  const nodeIndexToTarget = new Map();
  for (const tgt of chosenTargets) for (const idx of tgt.sampleNodeIndices) nodeIndexToTarget.set(idx, tgt);

  console.log(`\nPass C: scanning edges for retainers of ${allSampleIndices.length} sampled node instances ...`);
  t = Date.now();
  const { retainers, edgesParsed } = await scanEdgesForRetainers(FILE, edgeCountArr, allSampleIndices);
  console.log(`edges scanned: ${edgesParsed.toLocaleString()} (${Date.now() - t}ms) | retainer edges found: ${retainers.length}`);

  console.log('\n=== Direct retainers (1 hop) per sampled instance ===\n');
  for (const tgt of chosenTargets) {
    console.log(`--- [${tgt.category}] ${JSON.stringify(tgt.content.slice(0, 80))} (${tgt.count.toLocaleString()} total live instances) ---`);
    for (const sIdx of tgt.sampleNodeIndices) {
      const owners = retainers.filter((r) => r.targetNodeIndex === sIdx);
      if (owners.length === 0) {
        console.log(`  node#${sIdx}: NO RETAINER FOUND (likely a GC root, or edge_count bookkeeping issue - see caveats)`);
        continue;
      }
      for (const o of owners) {
        const ownerType = NODE_TYPES[typeArr[o.ownerNodeIndex]] ?? `type${typeArr[o.ownerNodeIndex]}`;
        const ownerNameIdx = nameArr[o.ownerNodeIndex];
        const ownerName = stringTable[ownerNameIdx] ?? `(nameIndex ${ownerNameIdx})`;
        const edgeTypeName = EDGE_TYPES[o.edgeType] ?? `type${o.edgeType}`;
        const edgeLabel = edgeTypeName === 'property' || edgeTypeName === 'shortcut' || edgeTypeName === 'internal'
          ? (stringTable[o.edgeNameOrIndex] ?? `(nameIndex ${o.edgeNameOrIndex})`)
          : `[${o.edgeNameOrIndex}]`;
        console.log(`  node#${sIdx} <- owner#${o.ownerNodeIndex} (${ownerType} "${String(ownerName).slice(0, 60)}") via ${edgeTypeName} edge "${edgeLabel}"`);
      }
    }
  }
  console.log('\nCaveat: this is a 1-hop direct retainer only. A generic "object"/"array" owner name often');
  console.log('means the real story is one more hop up (what holds THAT object). Re-run with those');
  console.log('owner node indices as new targets for a 2nd hop if the 1st hop is uninformative.');
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
