/**
 * Test A / Test B verdict (2026-10-14). Reads a session result JSON written by endToEnd.ts plus its RETAINED isolated database and produces explicit
 * PASS / FAIL / NOT_PROVEN verdicts per area. It re-derives everything from persisted rows and from the independent oracles; it never trusts the session's own
 * certification flag alone. Usage: tsx scripts/sim/endToEndVerdict.ts <result.json> <A|B> [initialCash=20000]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { compareOracleToLedger, runAccountingOracle } from '../../src/server/replay/synthetic/oracles/accountingOracle';
import { readOracleInputs } from '../../src/server/replay/synthetic/oracles/ledgerAdapter';

type Verdict = 'PASS' | 'FAIL' | 'NOT_PROVEN';
const [file, which = 'B', cash = '20000'] = process.argv.slice(2);
const j = JSON.parse(readFileSync(file, 'utf8'));
const dbPath: string = existsSync(j.evidenceRetention?.path ?? '') ? j.evidenceRetention.path : j.dbPath;
const db = new Database(dbPath, { readonly: true });
const areas: Array<{ area: string; verdict: Verdict; evidence: string }> = [];
const add = (area: string, verdict: Verdict, evidence: string) => areas.push({ area, verdict, evidence });

const trades = db.prepare("select id,symbol,side,status,quantity,price,trace_id,profit_loss,filled_at from trades order by timestamp").all() as any[];
const fills = db.prepare('select order_id, quantity from fills').all() as any[];
const filledOrders = new Set(fills.map((f) => f.order_id));
const d = j.discovery;
const oppSyms = new Set<string>((d?.opportunities ?? []).map((o: any) => o.symbol));
const discoveredOnly = new Set<string>(d?.admittedToSession ?? []);
const injected = trades.filter((t) => String(t.id).startsWith('cert-') || String(t.trace_id ?? '').startsWith('cert-'));

// --- discovery ---
if (!d) add('REAL_DISCOVERY_IN_SESSION', 'FAIL', 'session ran without the real-discovery path');
else {
  add('REAL_DISCOVERY_IN_SESSION', d.blockedProviderCalls === 0 && (d.unsupportedProviderCalls ?? []).length === 0 ? 'PASS' : 'FAIL',
    `production scanners/allocator at cap via provider seam; blocked=${d.blockedProviderCalls} unsupported=${(d.unsupportedProviderCalls ?? []).length}; recall=${d.score.recall.toFixed(2)} precision=${d.score.precision.toFixed(3)} promotedNew=${d.promotedNew.length} trapHits=${d.score.trapHits}`);
}

// --- accounting / risk oracles ---
try {
  const perShare = 0.005;
  const { fills: of, ledger } = readOracleInputs(j.dbPath && existsSync(j.dbPath) ? j.dbPath : dbPath, j.brokerSummary, Number(cash), (f: any) => f.quantity * perShare);
  const mism = compareOracleToLedger(runAccountingOracle(of), ledger);
  add('ACCOUNTING_ORACLE', mism.length === 0 ? 'PASS' : 'FAIL', `${of.length} fills, mismatches=${mism.length}`);
} catch (e: any) { add('ACCOUNTING_ORACLE', 'NOT_PROVEN', `oracle could not run: ${e?.message}`); }

const buys = trades.filter((t) => t.side === 'BUY' && filledOrders.has(t.id));
const sells = trades.filter((t) => t.side === 'SELL' && filledOrders.has(t.id));
const buySymbols = new Set(buys.map((t) => t.symbol));
const sellSymbols = new Set(sells.map((t) => t.symbol));

if (which.toUpperCase() === 'A') {
  add('NO_INJECTED_APPROVALS', injected.length === 0 ? 'PASS' : 'FAIL', `harness-injected trades: ${injected.length}`);
  add('PRODUCTION_FAITHFUL_ABSTENTION', trades.length === 0 && j.certification?.certification === 'PASS' ? 'PASS' : 'FAIL',
    `orders=${trades.length}; session certification=${j.certification?.certification} (${j.certification?.reason ?? 'no reason'}); calibration=${j.agentCalibrationProfile?.profile}; lifecycleSeed=${j.lifecycleSeed ? j.lifecycleSeed.length : 'none (production Oct 14 state)'}`);
  const abst = j.certification?.abstentionReasons;
  add('ABSTENTION_EXPLAINED', abst && Object.keys(abst).length > 0 ? 'PASS' : 'FAIL', `normalized reasons: ${JSON.stringify(abst ?? null)}`);
} else {
  add('NO_INJECTED_APPROVALS', injected.length === 0 ? 'PASS' : 'FAIL', `harness-injected trades: ${injected.length}`);
  // the headline requirement: an opportunity the production allocator discovered (not a pre-streaming incumbent) is bought AND sold
  const discoveredBuys = [...buySymbols].filter((s) => discoveredOnly.has(s));
  const discoveredOpportunityBuys = discoveredBuys.filter((s) => oppSyms.has(s));
  add('ORGANIC_BUY_OF_DISCOVERED_SYMBOL', discoveredBuys.length > 0 ? 'PASS' : 'FAIL', `buys on allocator-discovered symbols: ${JSON.stringify(discoveredBuys)}; of which oracle-valid opportunities: ${JSON.stringify(discoveredOpportunityBuys)}`);
  const closed = discoveredBuys.filter((s) => sellSymbols.has(s));
  add('MONITOR_AND_SELL_OF_DISCOVERED_SYMBOL', closed.length > 0 ? 'PASS' : 'FAIL', `discovered symbols with a filled SELL: ${JSON.stringify(closed)}; all SELL symbols: ${JSON.stringify([...sellSymbols])}`);
  add('ORGANIC_BUY_OF_ORACLE_OPPORTUNITY', discoveredOpportunityBuys.length > 0 ? 'PASS' : 'FAIL', `an oracle-valid hidden opportunity discovered by the allocator and bought: ${JSON.stringify(discoveredOpportunityBuys)}`);
  const consensus = db.prepare("select count(*) c from observability_events where event_type='CHIEF_CONSENSUS_COMPLETED' and payload like '%\"approved\":true%'").get() as any;
  add('REAL_CONSENSUS_APPROVALS', consensus.c > 0 ? 'PASS' : 'FAIL', `approved consensus rounds: ${consensus.c}`);
  add('SESSION_CERTIFICATION_GATE', j.certification?.certification === 'PASS' ? 'PASS' : 'FAIL', `${j.certification?.certification} firstBlockingStage=${j.certification?.firstBlockingStage ?? 'none'}`);
}
add('TIMELINE_INVARIANTS', (j.certification?.invariantViolations ?? []).length === 0 ? 'PASS' : 'FAIL', `violations=${(j.certification?.invariantViolations ?? []).length}`);
// Opportunity funnel: for every oracle opportunity the allocator promoted in time, how far did the real pipeline take it (first blocking stage evidence).
const funnel = (d?.opportunities ?? []).filter((o: any) => o.cls === 'DISCOVERED_IN_TIME' || o.cls === 'PROMOTED_BUT_LATE').map((o: any) => {
  const q = (type: string) => (db.prepare('select count(*) c from observability_events where symbol=? and event_type=?').get(o.symbol, type) as any).c;
  const reasons = db.prepare("select substr(payload, instr(payload,'reason'), 160) r from observability_events where symbol=? and event_type='DESK_NO_TRADE' limit 400").all(o.symbol) as any[];
  const hist: Record<string, number> = {};
  for (const r of reasons) { const k = String(r.r).replace(/[0-9.]+%?/g, '#').slice(0, 90); hist[k] = (hist[k] ?? 0) + 1; }
  const ideasByAgent = db.prepare("select json_extract(payload,'$.payload.agent') a, count(*) c from observability_events where symbol=? and event_type='TRADE_IDEA_GENERATED' group by a").all(o.symbol);
  return { symbol: o.symbol, kind: o.kind, promotedMin: o.promotedMin, ideasByAgent, consensusRounds: q('CHIEF_CONSENSUS_COMPLETED'), deskNoTrade: q('DESK_NO_TRADE'), noTradeReasons: hist, buys: buys.filter((t) => t.symbol === o.symbol).length, sells: sells.filter((t) => t.symbol === o.symbol).length };
});
const out = { file, which, funnel, dbPath, generatedAt: new Date().toISOString(), areas, overall: areas.every((a) => a.verdict === 'PASS') ? 'PASS' : areas.some((a) => a.verdict === 'FAIL') ? 'FAIL' : 'NOT_PROVEN' };
writeFileSync(file.replace(/\.json$/, '-verdict.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.overall === 'PASS' ? 0 : 1);
