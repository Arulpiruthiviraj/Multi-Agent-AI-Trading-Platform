// Usage: node scripts/forensic/analyzeCpuProfile.cjs <file.cpuprofile> [topN]
// Prints the heaviest non-idle self-time frames with their JS caller chains (native calls show up under the JS caller).
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const top = Number(process.argv[3]) || 6;
const idx = {}, par = {};
p.nodes.forEach((n) => { idx[n.id] = n; (n.children || []).forEach((c) => (par[c] = n.id)); });
const self = {};
p.samples.forEach((id, i) => { self[id] = (self[id] || 0) + (p.timeDeltas[i] || 0); });
const total = Object.values(self).reduce((a, b) => a + b, 0);
const rows = Object.entries(self).filter(([id]) => !['(idle)', '(program)', '(root)'].includes(idx[id].callFrame.functionName)).sort((a, b) => b[1] - a[1]).slice(0, top);
console.log('profile span', (total / 1e6).toFixed(1) + 's');
for (const [id, us] of rows) {
  let cur = +id; const chain = [];
  while (cur) { const n = idx[cur]; chain.push((n.callFrame.functionName || '(anon)') + ' ' + n.callFrame.url.split(/[\/]/).slice(-2).join('/') + ':' + n.callFrame.lineNumber); cur = par[cur]; }
  console.log((us / 1e6).toFixed(2) + 's', chain.slice(0, 7).join(' <- '));
}
