// Offline, read-only analysis of a preserved .heapsnapshot file - NEVER attaches to or disturbs
// any live process. Finds the immediate retainer(s) of trace_<SYMBOL>_<epochMs>_<hash>-shaped
// strings (P1-A's own dominant string shape) by parsing the V8 heap snapshot's flat nodes/edges
// arrays directly (typed arrays, not a full JSON.parse of the whole file - that would balloon
// memory far past what a 2GB/multi-GB snapshot can survive on this host).
const fs = require('fs');

const filePath = process.argv[2];
const sampleLimit = Number(process.argv[3] || 60);

function findTopLevelArrayBounds(buf, key) {
  const marker = `"${key}":[`;
  const start = buf.indexOf(marker);
  if (start === -1) throw new Error(`key not found: ${key}`);
  const arrStart = start + marker.length - 1; // position of the opening [
  // Find matching closing bracket by bracket-depth scan (strings array contains [ and ] only
  // inside quoted strings, so we must respect quotes/escapes for the strings section).
  let depth = 0, inStr = false, esc = false;
  for (let i = arrStart; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === 0x5c /* backslash */) { esc = true; }
      else if (c === 0x22 /* quote */) { inStr = false; }
      continue;
    }
    if (c === 0x22) { inStr = true; continue; }
    if (c === 0x5b /* [ */) depth++;
    else if (c === 0x5d /* ] */) { depth--; if (depth === 0) return [arrStart, i + 1]; }
  }
  throw new Error(`unterminated array: ${key}`);
}

console.log('reading file:', filePath);
const buf = fs.readFileSync(filePath); // Buffer - raw bytes, not parsed. One real allocation ~ file size.
console.log('file bytes:', buf.length);

function findMatchingBrace(buf, openPos) {
  let depth = 0, inStr = false, esc = false;
  for (let i = openPos; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === 0x5c) { esc = true; }
      else if (c === 0x22) { inStr = false; }
      continue;
    }
    if (c === 0x22) { inStr = true; continue; }
    if (c === 0x7b /* { */) depth++;
    else if (c === 0x7d /* } */) { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unterminated object');
}
const metaMarker = '"meta":';
const metaStart = buf.indexOf(metaMarker);
const metaOpenPos = buf.indexOf('{', metaStart);
const metaClosePos = findMatchingBrace(buf, metaOpenPos);
const metaJson = JSON.parse(buf.slice(metaOpenPos, metaClosePos).toString('utf8'));
const nodeFields = metaJson.node_fields;
const edgeFields = metaJson.edge_fields;
const nodeTypes = metaJson.node_types[0];
console.log('node_fields', nodeFields, 'edge_fields', edgeFields);
const NF = nodeFields.length, EF = edgeFields.length;
const TYPE_IDX = nodeFields.indexOf('type');
const NAME_IDX = nodeFields.indexOf('name');
const EDGE_COUNT_IDX = nodeFields.indexOf('edge_count');
const E_TYPE_IDX = edgeFields.indexOf('type');
const E_NAMEIDX_IDX = edgeFields.indexOf('name_or_index');
const E_TONODE_IDX = edgeFields.indexOf('to_node');
const STRING_TYPE = nodeTypes.indexOf('string');
console.log('string type id =', STRING_TYPE);

function parseFlatNumberArray(sectionStart, sectionEnd) {
  // Fast manual scan: numbers separated by commas inside [ ... ]. No floats expected (all ints).
  const out = [];
  let i = sectionStart + 1; // skip '['
  let cur = 0, curStarted = false, neg = false;
  while (i < sectionEnd) {
    const c = buf[i];
    if (c >= 0x30 && c <= 0x39) { cur = cur * 10 + (c - 0x30); curStarted = true; }
    else if (c === 0x2d) { neg = true; }
    else if (c === 0x2c || c === 0x5d) {
      if (curStarted) { out.push(neg ? -cur : cur); }
      cur = 0; curStarted = false; neg = false;
    }
    i++;
  }
  return out;
}

console.log('locating nodes[] ...');
const [nodesStart, nodesEnd] = findTopLevelArrayBounds(buf, 'nodes');
console.log('parsing nodes[] ...', nodesEnd - nodesStart, 'bytes');
const nodesArr = parseFlatNumberArray(nodesStart, nodesEnd);
console.log('node numbers parsed:', nodesArr.length, 'expected multiple of', NF);
const nodeCount = nodesArr.length / NF;
console.log('node count:', nodeCount);

console.log('locating edges[] ...');
const [edgesStart, edgesEnd] = findTopLevelArrayBounds(buf, 'edges');
console.log('parsing edges[] ...', edgesEnd - edgesStart, 'bytes');
const edgesArr = parseFlatNumberArray(edgesStart, edgesEnd);
const edgeCount = edgesArr.length / EF;
console.log('edge count:', edgeCount);

console.log('locating strings[] ...');
const [strStart, strEnd] = findTopLevelArrayBounds(buf, 'strings');
const stringsJsonText = buf.slice(strStart, strEnd).toString('utf8');
console.log('parsing strings JSON (', stringsJsonText.length, 'chars )...');
const strings = JSON.parse(stringsJsonText);
console.log('string count:', strings.length);

// Find trace-id-shaped strings.
const traceRe = /^trace_[A-Za-z0-9.]+_\d{10,}_[a-f0-9]+$/;
let matchCount = 0;
const targetStringIdx = new Set();
for (let i = 0; i < strings.length; i++) {
  if (traceRe.test(strings[i])) { matchCount++; targetStringIdx.add(i); }
}
console.log('distinct trace-id-SHAPED strings in string table:', matchCount);
console.log('sample:', [...targetStringIdx].slice(0, 5).map(i => strings[i]));

// Find string-type NODE indices whose name references one of our target string indices.
const targetNodeIdx = new Set();
for (let n = 0; n < nodeCount; n++) {
  const base = n * NF;
  if (nodesArr[base + TYPE_IDX] === STRING_TYPE && targetStringIdx.has(nodesArr[base + NAME_IDX])) {
    targetNodeIdx.add(n);
  }
}
console.log('string-type NODE instances matching the shape:', targetNodeIdx.size);

// Walk nodes in order, consuming edge_count edges per node from the edges array sequentially,
// recording which SOURCE node points to each target node (immediate retainer).
const retainerSamples = [];
let edgePos = 0;
for (let n = 0; n < nodeCount && retainerSamples.length < sampleLimit * 3; n++) {
  const base = n * NF;
  const ec = nodesArr[base + EDGE_COUNT_IDX];
  for (let e = 0; e < ec; e++) {
    const eb = (edgePos + e) * EF;
    const toNodeOffset = edgesArr[eb + E_TONODE_IDX];
    const toNodeIdx = toNodeOffset / NF;
    if (targetNodeIdx.has(toNodeIdx)) {
      const srcType = nodesArr[base + TYPE_IDX];
      const srcName = nodesArr[base + NAME_IDX];
      const srcTypeName = nodeTypes[srcType];
      const edgeType = edgesArr[eb + E_TYPE_IDX];
      const edgeTypeNames = metaJson.edge_types[0];
      const edgeNameOrIdx = edgesArr[eb + E_NAMEIDX_IDX];
      retainerSamples.push({
        targetNode: toNodeIdx,
        srcNodeIdx: n,
        srcType: srcTypeName,
        srcName: (srcTypeName === 'object' || srcTypeName === 'string' || srcTypeName === 'closure') ? strings[srcName] : srcName,
        edgeType: edgeTypeNames[edgeType],
        edgeNameOrIdx: (edgeTypeNames[edgeType] === 'property' || edgeTypeNames[edgeType] === 'internal' || edgeTypeNames[edgeType] === 'shortcut' || edgeTypeNames[edgeType] === 'context') ? strings[edgeNameOrIdx] : edgeNameOrIdx,
      });
    }
  }
  edgePos += ec;
}

console.log('\n=== RETAINER SAMPLES (immediate predecessor of a matching string node) ===');
console.log(JSON.stringify(retainerSamples.slice(0, sampleLimit), null, 2));

// Aggregate by (srcType, srcName-ish, edgeType) to see the DOMINANT retaining shape.
const agg = new Map();
for (const r of retainerSamples) {
  const key = `${r.srcType} | ${typeof r.srcName === 'string' ? r.srcName.slice(0, 60) : r.srcName} | via ${r.edgeType}`;
  agg.set(key, (agg.get(key) || 0) + 1);
}
console.log('\n=== AGGREGATED RETAINER SHAPES (sampled) ===');
console.log(JSON.stringify([...agg.entries()].sort((a, b) => b[1] - a[1]), null, 2));

// Second-level walk: for every "hidden"-type immediate retainer found above, find ITS OWN
// retainers too - a "hidden" node is usually an internal backing store (e.g. a FixedArray behind
// a JS Array), so its own retainer reveals the actual owning Array/object.
const hiddenTargets = new Set(retainerSamples.filter(r => r.srcType === 'hidden').map(r => r.srcNodeIdx));
console.log('\nsecond-level walk: looking for retainers of', hiddenTargets.size, 'hidden intermediary nodes...');
const level2Samples = [];
edgePos = 0;
for (let n = 0; n < nodeCount && level2Samples.length < sampleLimit * 2; n++) {
  const base = n * NF;
  const ec = nodesArr[base + EDGE_COUNT_IDX];
  for (let e = 0; e < ec; e++) {
    const eb = (edgePos + e) * EF;
    const toNodeOffset = edgesArr[eb + E_TONODE_IDX];
    const toNodeIdx = toNodeOffset / NF;
    if (hiddenTargets.has(toNodeIdx)) {
      const srcType = nodesArr[base + TYPE_IDX];
      const srcName = nodesArr[base + NAME_IDX];
      const srcTypeName = nodeTypes[srcType];
      const edgeType = edgesArr[eb + E_TYPE_IDX];
      const edgeTypeNames = metaJson.edge_types[0];
      const edgeNameOrIdx = edgesArr[eb + E_NAMEIDX_IDX];
      level2Samples.push({
        hiddenNode: toNodeIdx,
        srcNodeIdx: n,
        srcType: srcTypeName,
        srcName: (srcTypeName === 'object' || srcTypeName === 'string' || srcTypeName === 'closure' || srcTypeName === 'array' || srcTypeName === 'native' || srcTypeName === 'synthetic') ? strings[srcName] : srcName,
        edgeType: edgeTypeNames[edgeType],
        edgeNameOrIdx: (edgeTypeNames[edgeType] === 'property' || edgeTypeNames[edgeType] === 'internal' || edgeTypeNames[edgeType] === 'shortcut' || edgeTypeNames[edgeType] === 'context') ? strings[edgeNameOrIdx] : edgeNameOrIdx,
      });
    }
  }
  edgePos += ec;
}
const agg2 = new Map();
for (const r of level2Samples) {
  const key = `${r.srcType} | ${typeof r.srcName === 'string' ? r.srcName.slice(0, 80) : r.srcName} | via ${r.edgeType}(${r.edgeNameOrIdx})`;
  agg2.set(key, (agg2.get(key) || 0) + 1);
}
console.log('\n=== LEVEL-2 RETAINER SHAPES (who owns the hidden intermediary) ===');
console.log(JSON.stringify([...agg2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25), null, 2));
console.log('\nstring[63] =', JSON.stringify(strings[63]));

// Third-level walk: who retains the plain "Object" instances that directly hold a `traceId`
// property (the real application-level owner, not V8's internal PropertyArray plumbing)?
const objectTargets = new Set(retainerSamples.filter(r => r.srcType === 'object' && r.edgeNameOrIdx === 'traceId').map(r => r.srcNodeIdx));
console.log('\nthird-level walk: looking for retainers of', objectTargets.size, 'Object instances that directly hold traceId...');
const level3Samples = [];
edgePos = 0;
for (let n = 0; n < nodeCount && level3Samples.length < sampleLimit * 2; n++) {
  const base = n * NF;
  const ec = nodesArr[base + EDGE_COUNT_IDX];
  for (let e = 0; e < ec; e++) {
    const eb = (edgePos + e) * EF;
    const toNodeOffset = edgesArr[eb + E_TONODE_IDX];
    const toNodeIdx = toNodeOffset / NF;
    if (objectTargets.has(toNodeIdx)) {
      const srcType = nodesArr[base + TYPE_IDX];
      const srcName = nodesArr[base + NAME_IDX];
      const srcTypeName = nodeTypes[srcType];
      const edgeType = edgesArr[eb + E_TYPE_IDX];
      const edgeTypeNames = metaJson.edge_types[0];
      const edgeNameOrIdx = edgesArr[eb + E_NAMEIDX_IDX];
      level3Samples.push({
        objNode: toNodeIdx,
        srcNodeIdx: n,
        srcType: srcTypeName,
        srcName: (typeof srcName === 'number' && srcName < strings.length && srcName >= 0) ? strings[srcName] : srcName,
        edgeType: edgeTypeNames[edgeType],
        edgeNameOrIdx: (edgeTypeNames[edgeType] === 'property' || edgeTypeNames[edgeType] === 'internal' || edgeTypeNames[edgeType] === 'shortcut' || edgeTypeNames[edgeType] === 'context') ? strings[edgeNameOrIdx] : edgeNameOrIdx,
      });
    }
  }
  edgePos += ec;
}
const agg3 = new Map();
for (const r of level3Samples) {
  const key = `${r.srcType} | ${typeof r.srcName === 'string' ? r.srcName.slice(0, 100) : r.srcName} | via ${r.edgeType}(${r.edgeNameOrIdx})`;
  agg3.set(key, (agg3.get(key) || 0) + 1);
}
console.log('\n=== LEVEL-3 RETAINER SHAPES (who owns the Object holding traceId) ===');
console.log(JSON.stringify([...agg3.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30), null, 2));

// Level 4: the array(s) that directly hold these traceId-bearing objects as elements - how many
// elements does EACH such array actually have (its own node's edge_count / self_size are a proxy
// for size), and who retains the array itself (the real application-level owner)?
const arrayNodeTargets = new Set(level3Samples.filter(r => r.srcType === 'array').map(r => r.srcNodeIdx));
console.log('\ndistinct backing ARRAY node(s) found holding traceId-bearing objects:', arrayNodeTargets.size);
for (const arrNode of arrayNodeTargets) {
  const base = arrNode * NF;
  console.log('array node', arrNode, '-> self_size:', nodesArr[base + nodeFields.indexOf('self_size')], 'edge_count:', nodesArr[base + EDGE_COUNT_IDX], 'id:', nodesArr[base + nodeFields.indexOf('id')]);
}
const level4Samples = [];
edgePos = 0;
for (let n = 0; n < nodeCount && level4Samples.length < 40; n++) {
  const base = n * NF;
  const ec = nodesArr[base + EDGE_COUNT_IDX];
  for (let e = 0; e < ec; e++) {
    const eb = (edgePos + e) * EF;
    const toNodeOffset = edgesArr[eb + E_TONODE_IDX];
    const toNodeIdx = toNodeOffset / NF;
    if (arrayNodeTargets.has(toNodeIdx)) {
      const srcType = nodesArr[base + TYPE_IDX];
      const srcName = nodesArr[base + NAME_IDX];
      const srcTypeName = nodeTypes[srcType];
      const edgeType = edgesArr[eb + E_TYPE_IDX];
      const edgeTypeNames = metaJson.edge_types[0];
      const edgeNameOrIdx = edgesArr[eb + E_NAMEIDX_IDX];
      level4Samples.push({
        arrNode: toNodeIdx,
        srcNodeIdx: n,
        srcType: srcTypeName,
        srcName: (typeof srcName === 'number' && srcName < strings.length && srcName >= 0) ? strings[srcName] : srcName,
        edgeType: edgeTypeNames[edgeType],
        edgeNameOrIdx: (edgeTypeNames[edgeType] === 'property' || edgeTypeNames[edgeType] === 'internal' || edgeTypeNames[edgeType] === 'shortcut' || edgeTypeNames[edgeType] === 'context') ? strings[edgeNameOrIdx] : edgeNameOrIdx,
      });
    }
  }
  edgePos += ec;
}
console.log('\n=== LEVEL-4 RETAINER SHAPES (who owns the Array) ===');
console.log(JSON.stringify(level4Samples, null, 2));

// Level 5: who retains the actual application-visible Array INSTANCE (not its elements backing
// store)? This is the field/class that owns the leaking array.
const arrayInstanceTargets = new Set(level4Samples.map(r => r.srcNodeIdx));
console.log('\nlevel 5: looking for retainers of', arrayInstanceTargets.size, 'Array instance(s)...');
const level5Samples = [];
edgePos = 0;
for (let n = 0; n < nodeCount; n++) {
  const base = n * NF;
  const ec = nodesArr[base + EDGE_COUNT_IDX];
  for (let e = 0; e < ec; e++) {
    const eb = (edgePos + e) * EF;
    const toNodeOffset = edgesArr[eb + E_TONODE_IDX];
    const toNodeIdx = toNodeOffset / NF;
    if (arrayInstanceTargets.has(toNodeIdx)) {
      const srcType = nodesArr[base + TYPE_IDX];
      const srcName = nodesArr[base + NAME_IDX];
      const srcTypeName = nodeTypes[srcType];
      const edgeType = edgesArr[eb + E_TYPE_IDX];
      const edgeTypeNames = metaJson.edge_types[0];
      const edgeNameOrIdx = edgesArr[eb + E_NAMEIDX_IDX];
      level5Samples.push({
        arrInstanceNode: toNodeIdx,
        srcNodeIdx: n,
        srcType: srcTypeName,
        srcName: (typeof srcName === 'number' && srcName < strings.length && srcName >= 0) ? strings[srcName] : srcName,
        edgeType: edgeTypeNames[edgeType],
        edgeNameOrIdx: (edgeTypeNames[edgeType] === 'property' || edgeTypeNames[edgeType] === 'internal' || edgeTypeNames[edgeType] === 'shortcut' || edgeTypeNames[edgeType] === 'context') ? strings[edgeNameOrIdx] : edgeNameOrIdx,
      });
    }
  }
  edgePos += ec;
}
console.log('\n=== LEVEL-5 RETAINER SHAPES (who owns the Array INSTANCE - the real leak owner) ===');
console.log(JSON.stringify(level5Samples, null, 2));

// Dump the FULL property list of a few sample traceId-bearing Objects (not just the traceId edge)
// to match their shape against a known object literal in the source code.
console.log('\n=== FULL PROPERTY SHAPE of sample traceId-bearing Objects ===');
const sampleObjNodes = [...objectTargets].slice(0, 5);
edgePos = 0;
const shapeByNode = new Map(sampleObjNodes.map(n => [n, []]));
for (let n = 0; n < nodeCount; n++) {
  const base = n * NF;
  const ec = nodesArr[base + EDGE_COUNT_IDX];
  if (sampleObjNodes.includes(n)) {
    for (let e = 0; e < ec; e++) {
      const eb = (edgePos + e) * EF;
      const edgeType = edgesArr[eb + E_TYPE_IDX];
      const edgeTypeNames = metaJson.edge_types[0];
      const edgeNameOrIdx = edgesArr[eb + E_NAMEIDX_IDX];
      const toNodeOffset = edgesArr[eb + E_TONODE_IDX];
      const toNodeIdx = toNodeOffset / NF;
      const tBase = toNodeIdx * NF;
      const tType = nodeTypes[nodesArr[tBase + TYPE_IDX]];
      const tName = nodesArr[tBase + NAME_IDX];
      const label = edgeTypeNames[edgeType] === 'property' || edgeTypeNames[edgeType] === 'internal' ? strings[edgeNameOrIdx] : `#${edgeNameOrIdx}`;
      let valuePreview = tType;
      if (tType === 'string' && typeof tName === 'number') valuePreview = `string:"${String(strings[tName]).slice(0, 40)}"`;
      else if (tType === 'number') valuePreview = `number`;
      shapeByNode.get(n).push(`${label}=${valuePreview}`);
    }
  }
  edgePos += ec;
}
for (const [node, fields] of shapeByNode) {
  console.log('node', node, ':', fields.filter(f => !f.startsWith('map=') && !f.startsWith('properties=')).join(', '));
}
