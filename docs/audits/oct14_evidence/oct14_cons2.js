// Population statistics over every Oct 14 CONSENSUS_TERMINAL_REASON record (read-only snapshot).
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const dir = 'C:/Users/ithay/AppData/Local/Temp/J/db_backup/';
const snap = fs.readdirSync(dir).filter((x) => /postclose.*\.db$/.test(x)).sort().pop();
const db = new D(dir + snap, { readonly: true, fileMustExist: true });
const A = Date.parse('2026-10-14T13:30:00Z'), B = Date.parse('2026-10-14T20:00:00Z');
const agentCount = {}, agentSide = {}, bins = {}, groupsHist = {}, req = {};
let n = 0, buyAgreeGroups2 = 0, sellAgreeGroups2 = 0, anyAgree2 = 0, maxFinal = 0, ge60 = 0, ge75 = 0, buyAgree2conf = [], techBuyHigh = 0, techBuyHighSyms = new Set(), quantEngineRows = 0;
const symsWith2 = new Set(); const recs2 = [];
for (const r of db.prepare("select symbol, payload, ts from observability_events where event_type = 'CONSENSUS_TERMINAL_REASON' and ts between ? and ?").iterate(A, B)) {
  let p; try { p = JSON.parse(r.payload); p = p.payload || p; } catch { continue; }
  n++;
  const fc = Number(p.finalConfidence ?? 0); maxFinal = Math.max(maxFinal, fc);
  const bin = (Math.floor(fc * 10) / 10).toFixed(1); bins[bin] = (bins[bin] || 0) + 1;
  if (fc >= 0.6) ge60++; if (fc >= 0.75) ge75++;
  const g = p.independentEvidenceGroupCount ?? -1; groupsHist[g] = (groupsHist[g] || 0) + 1; req[p.requiredIndependentEvidenceGroups] = (req[p.requiredIndependentEvidenceGroups] || 0) + 1;
  const sideGroups = { BUY: new Set(), SELL: new Set() };
  for (const a of (p.participatingAgents || [])) {
    agentCount[a.agent] = (agentCount[a.agent] || 0) + 1;
    const k = a.agent + '|' + a.side; agentSide[k] = (agentSide[k] || 0) + 1;
    if (a.agent === 'QuantEngine') quantEngineRows++;
    if (a.side === 'BUY' || a.side === 'SELL') {
      const grp = (p.evidenceFamilies || []).find((f) => f.agent === a.agent)?.independentEvidenceGroup || a.agent;
      sideGroups[a.side].add(grp);
    }
    if (a.agent === 'TechnicalAgent' && a.side === 'BUY' && a.confidence >= 0.75) { techBuyHigh++; techBuyHighSyms.add(r.symbol); }
  }
  if (sideGroups.BUY.size >= 2) { buyAgreeGroups2++; recs2.push({ s: r.symbol, ts: r.ts, fc, side: 'BUY', code: p.terminalReasonCode, agents: (p.participatingAgents || []).map((a) => a.agent + ':' + a.side + ':' + (+a.confidence).toFixed(2)) }); }
  if (sideGroups.SELL.size >= 2) sellAgreeGroups2++;
  if (sideGroups.BUY.size >= 2 || sideGroups.SELL.size >= 2) { anyAgree2++; symsWith2.add(r.symbol); }
}
const out = { snapshot: snap, records: n, agentParticipation: agentCount, agentSide, finalConfidenceBins: bins, independentGroupsHistogram: groupsHist, requiredGroups: req, recordsWith2PlusGroupsAgreeingBUY: buyAgreeGroups2, recordsWith2PlusGroupsAgreeingSELL: sellAgreeGroups2, recordsWithAny2PlusAgreement: anyAgree2, symbolsWithAny2PlusAgreement: symsWith2.size, maxFinalConfidence: +maxFinal.toFixed(3), finalConfidenceGE60: ge60, finalConfidenceGE75: ge75, technicalBuyConfidenceGE75Evaluations: techBuyHigh, technicalBuyGE75Symbols: techBuyHighSyms.size, quantEngineParticipations: quantEngineRows, sampleBUY2Groups: recs2.sort((a, b) => b.fc - a.fc).slice(0, 12).map((x) => ({ ...x, ts: new Date(x.ts).toISOString().slice(11, 19) })) };
fs.writeFileSync('C:/Users/ithay/AppData/Local/Temp/J/oct14_cons2.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 0).slice(0, 3500));
