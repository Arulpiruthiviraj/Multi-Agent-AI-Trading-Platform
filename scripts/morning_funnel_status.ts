/**
 * Morning universe/subscription/agent funnel status — read-only, never invents data.
 * Usage: npx tsx scripts/morning_funnel_status.ts [YYYY-MM-DD]  (defaults to today, UTC-day prefix
 * match against timestamps, matching every other same-day query this session used).
 *
 * Built 2026-09-16 (overnight pre-market readiness pass) specifically to answer, without
 * re-deriving the queries from scratch each time: did the SIP-ADV fix and the
 * OpportunityDiscovery BROAD_UNIVERSE_TOPUP fix actually get more real symbols into the alpha
 * stack today? Opens data/argus.db in { readonly: true } mode via better-sqlite3 directly - never
 * imports src/server/db (which opens a non-readonly connection and pulls in the full boot module
 * graph) and never competes with the live engine as a second writer. Safe to run at any time,
 * including while the real engine is running.
 *
 * Does not modify anything. Does not place orders, does not touch calibration, does not restart
 * anything. Prints a plain-text report and exits.
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = process.env.ARGUS_DB_PATH || path.join(process.cwd(), 'data', 'argus.db');
const dayArg = process.argv[2];
const day = dayArg || new Date().toISOString().slice(0, 10);

function main() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const tsStart = Date.parse(`${day}T00:00:00Z`);
  const tsNow = Date.now();

  const section = (title: string) => console.log(`\n===== ${title} =====`);

  section(`Morning funnel status — ${day}`);

  // 1. Universe: scanned / admitted (broad-universe discovery layer).
  const discoveryRows = db.prepare(
    "SELECT symbol, event_type, payload, ts FROM observability_events WHERE event_type IN ('DISCOVERY_CANDIDATE_FILTERED','DISCOVERY_CANDIDATE_ADMITTED') AND ts >= ? AND ts <= ?"
  ).all(tsStart, tsNow) as Array<{ symbol: string; event_type: string; payload: string; ts: number }>;
  const bySymbol = new Map<string, { admitted: boolean; reason: string | null }[]>();
  for (const r of discoveryRows) {
    let p: any = {};
    try { p = JSON.parse(r.payload); } catch { /* ignore */ }
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push({ admitted: r.event_type === 'DISCOVERY_CANDIDATE_ADMITTED', reason: p.reason ?? null });
  }
  let admittedCount = 0;
  const advBelowFloor: string[] = [];
  const advDataUnavailable: string[] = [];
  for (const [sym, events] of bySymbol) {
    const last = events[events.length - 1];
    if (last.admitted) admittedCount += 1;
    else if (last.reason === 'ADV_BELOW_FLOOR') advBelowFloor.push(sym);
    else if (last.reason === 'ADV_DATA_UNAVAILABLE') advDataUnavailable.push(sym);
  }
  console.log('Distinct symbols scanned (broad universe):', bySymbol.size);
  console.log('Admitted:', admittedCount);
  console.log('ADV_BELOW_FLOOR (real, legitimate):', advBelowFloor.length);
  console.log('ADV_DATA_UNAVAILABLE (SIP gap / FMP-exhaustion class):', advDataUnavailable.length);

  // 2. Subscriptions requested, by reason (BROAD_UNIVERSE_TOPUP is the fix under test).
  section('Subscription requests, by reason');
  const subRows = db.prepare(
    "SELECT payload FROM observability_events WHERE event_type='WATCHLIST_SUBSCRIBE_REQUESTED' AND ts >= ? AND ts <= ?"
  ).all(tsStart, tsNow) as Array<{ payload: string }>;
  const reasonCount: Record<string, number> = {};
  for (const r of subRows) {
    let p: any = {};
    try { p = JSON.parse(r.payload); } catch { /* ignore */ }
    const inner = p.payload ?? p;
    const reason = inner.reason ?? 'UNKNOWN';
    reasonCount[reason] = (reasonCount[reason] || 0) + 1;
  }
  console.log(reasonCount);
  console.log('Total subscribe requests:', subRows.length);

  // 3. IBKR entitlement rejections (code 354 class).
  section('IBKR market-data errors (entitlement rejections)');
  const ibkrErr = db.prepare(
    "SELECT symbol, COUNT(*) n FROM observability_events WHERE event_type='IBKR_MARKET_DATA_ERROR' AND ts >= ? AND ts <= ? GROUP BY symbol ORDER BY n DESC LIMIT 30"
  ).all(tsStart, tsNow);
  console.log(ibkrErr);

  // 4. Agent reach: distinct symbols per agent today.
  section('Agent reach (distinct symbols with a real prediction today)');
  for (const agent of ['TechnicalAgent', 'KronosEngine', 'QuantEngine', 'JavaCoreEnsemble']) {
    const row = db.prepare(
      "SELECT COUNT(DISTINCT symbol) n FROM agent_predictions WHERE agent_name = ? AND timestamp LIKE ? || '%'"
    ).get(agent, day) as { n: number };
    console.log(agent + ':', row.n);
  }

  // 5. Decision funnel.
  section('Decision funnel');
  const ideaCount = (db.prepare("SELECT COUNT(*) n FROM observability_events WHERE event_type='TRADE_IDEA_GENERATED' AND ts >= ? AND ts <= ?").get(tsStart, tsNow) as { n: number }).n;
  const consensusRows = db.prepare("SELECT lifecycle_status, COUNT(*) n FROM transaction_traces WHERE created_at LIKE ? || '%' GROUP BY lifecycle_status").all(day);
  const riskCount = (db.prepare("SELECT COUNT(*) n FROM risk_assessments WHERE created_at LIKE ? || '%'").get(day) as { n: number }).n;
  const tradeCount = (db.prepare("SELECT COUNT(*) n FROM trades WHERE submitted_at LIKE ? || '%'").get(day) as { n: number }).n;
  console.log('Trade ideas:', ideaCount);
  console.log('Consensus (by lifecycle_status):', consensusRows);
  console.log('Risk assessments:', riskCount);
  console.log('Trades (orders):', tradeCount);
  const portfolio = db.prepare('SELECT * FROM portfolio').all();
  console.log('Current portfolio:', portfolio);

  // 6. Sample symbol trace table (the exact table the pre-market readiness mandate asked for).
  section('Sample symbol trace: Admitted / Subscribed / IBKR result / Agent reach');
  const sampleSymbols = ['AAPL', 'AMD', 'AMZN', 'AVGO', 'SPY', 'QQQ', 'GLD'];
  for (const sym of sampleSymbols) {
    const admitted = bySymbol.has(sym) ? (bySymbol.get(sym)!.at(-1)!.admitted ? 'YES' : 'NO') : 'NOT_SCANNED';
    const subReq = (db.prepare("SELECT COUNT(*) n FROM observability_events WHERE event_type='WATCHLIST_SUBSCRIBE_REQUESTED' AND symbol=? AND ts>=? AND ts<=?").get(sym, tsStart, tsNow) as { n: number }).n;
    const ibkrRej = (db.prepare("SELECT COUNT(*) n FROM observability_events WHERE event_type='IBKR_MARKET_DATA_ERROR' AND symbol=? AND ts>=? AND ts<=?").get(sym, tsStart, tsNow) as { n: number }).n;
    const tech = (db.prepare("SELECT COUNT(*) n FROM agent_predictions WHERE agent_name='TechnicalAgent' AND symbol=? AND timestamp LIKE ? || '%'").get(sym, day) as { n: number }).n;
    const kronos = (db.prepare("SELECT COUNT(*) n FROM agent_predictions WHERE agent_name='KronosEngine' AND symbol=? AND timestamp LIKE ? || '%'").get(sym, day) as { n: number }).n;
    const quant = (db.prepare("SELECT COUNT(*) n FROM agent_predictions WHERE agent_name='QuantEngine' AND symbol=? AND timestamp LIKE ? || '%'").get(sym, day) as { n: number }).n;
    const java = (db.prepare("SELECT COUNT(*) n FROM agent_predictions WHERE agent_name='JavaCoreEnsemble' AND symbol=? AND timestamp LIKE ? || '%'").get(sym, day) as { n: number }).n;
    console.log(
      sym.padEnd(6),
      '| admitted=' + admitted.padEnd(11),
      '| subReq=' + String(subReq).padEnd(4),
      '| ibkrRejected=' + String(ibkrRej).padEnd(4),
      '| Technical=' + String(tech).padEnd(3),
      '| Kronos=' + String(kronos).padEnd(3),
      '| Quant=' + String(quant).padEnd(3),
      '| Java=' + String(java),
    );
  }

  db.close();
}

main();
