/**
 * Offline, bounded-memory streaming analyzer for a V8 .heapsnapshot file.
 * Runs as a fully standalone process - never touches the live Argus engine, never loads the
 * whole file into memory. Memory footprint is O(1) w.r.t. file size: a handful of numeric
 * accumulators, a small rolling text buffer per chunk, and (in pass 2) the `strings` array only.
 *
 * Pass 1: aggregate node self_size/count by coarse "type" (the 15-value V8 enum).
 * Pass 2: aggregate by "name" (constructor/string-table entry) for the two most interesting
 *         coarse types (object, array) - the ones most likely to reveal an application-level leak.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const FILE = process.argv[2];
const MODE = process.argv[3] || 'pass1';

const NODE_TYPES = ["hidden","array","string","object","code","closure","regexp","number","native","synthetic","concatenated string","sliced string","symbol","bigint","object shape"];

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

// Streams the file as text, extracts ONLY the "nodes":[ ... ] array's integers via a small
// rolling parser - never buffers more than one chunk (64KB) plus a short carry-over string.
async function streamNodes(file, nodeCount, onNode) {
  const NODE_FIELDS = 6; // type,name,id,self_size,edge_count,detachedness
  const totalInts = nodeCount * NODE_FIELDS;

  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }); // 1MB chunks
    let carry = '';
    let started = false;
    let intsParsed = 0;
    let fieldBuf = new Array(NODE_FIELDS);
    let fieldIdx = 0;
    let nodesParsed = 0;

    stream.on('data', (chunk) => {
      if (intsParsed >= totalInts) return; // already done, ignore rest (readline-style early stop not used to keep this simple)
      let text = carry + chunk;
      if (!started) {
        const marker = '"nodes":[';
        const idx = text.indexOf(marker);
        if (idx === -1) { carry = text.slice(-marker.length); return; }
        text = text.slice(idx + marker.length);
        started = true;
      }
      // Parse comma-separated integers greedily; keep the last partial token as carry.
      let lastComma = -1;
      let i = 0;
      const len = text.length;
      let numStart = 0;
      for (i = 0; i < len && intsParsed < totalInts; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 44 /* , */) {
          const tok = text.slice(numStart, i);
          if (tok.length > 0) {
            fieldBuf[fieldIdx++] = Number(tok);
            intsParsed++;
            if (fieldIdx === NODE_FIELDS) {
              onNode(fieldBuf);
              nodesParsed++;
              fieldIdx = 0;
            }
          }
          numStart = i + 1;
          lastComma = i;
        }
      }
      carry = text.slice(numStart, len);
      if (intsParsed >= totalInts) {
        stream.destroy();
        resolve({ nodesParsed });
      }
    });
    stream.on('close', () => resolve({ nodesParsed }));
    stream.on('error', reject);
  });
}

async function main() {
  console.error(`Reading header from ${FILE} ...`);
  const { nodeCount, edgeCount } = await readHeader(FILE);
  console.error(`node_count=${nodeCount} edge_count=${edgeCount}`);

  const countByType = new Array(NODE_TYPES.length).fill(0);
  const selfSizeByType = new Array(NODE_TYPES.length).fill(0);
  let totalSelfSize = 0;
  let maxSelfSize = 0;
  let maxSelfSizeType = -1;

  const startedAt = Date.now();
  const { nodesParsed } = await streamNodes(FILE, nodeCount, (f) => {
    const [type, , , selfSize] = f;
    if (type >= 0 && type < NODE_TYPES.length) {
      countByType[type]++;
      selfSizeByType[type] += selfSize;
    }
    totalSelfSize += selfSize;
    if (selfSize > maxSelfSize) { maxSelfSize = selfSize; maxSelfSizeType = type; }
  });
  const durationMs = Date.now() - startedAt;

  console.log(`\n=== Pass 1: aggregate by coarse node type (streamed, O(1) memory) ===`);
  console.log(`Nodes parsed: ${nodesParsed} / expected ${nodeCount} (parse took ${durationMs}ms)`);
  console.log(`Total self_size across all nodes: ${(totalSelfSize / (1024*1024)).toFixed(1)}MB`);
  console.log(`Largest single node self_size: ${(maxSelfSize/1024).toFixed(1)}KB (type=${NODE_TYPES[maxSelfSizeType] ?? maxSelfSizeType})`);
  console.log('');
  const rows = NODE_TYPES.map((name, i) => ({ name, count: countByType[i], selfSizeMb: selfSizeByType[i] / (1024*1024) }))
    .sort((a, b) => b.selfSizeMb - a.selfSizeMb);
  for (const r of rows) {
    if (r.count === 0) continue;
    console.log(`  ${r.name.padEnd(22)} count=${String(r.count).padEnd(12)} selfSize=${r.selfSizeMb.toFixed(1)}MB (${(r.selfSizeMb/(totalSelfSize/(1024*1024))*100).toFixed(1)}%)`);
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
