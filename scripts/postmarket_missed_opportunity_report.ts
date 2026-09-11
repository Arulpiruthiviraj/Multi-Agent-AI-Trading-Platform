/**
 * Postmarket Missed-Opportunity Forensic Report — Phase 1 (2026-09-10, scoped).
 *
 * Read-only, standalone. Does NOT import src/server/db (the live Argus process is the sole
 * writer to data/argus.db per CLAUDE.md's one-writer rule) - uses a direct better-sqlite3
 * readonly connection instead, safe to run alongside a live engine. Does NOT write any bars
 * back into ohlcv_bars - a direct, read-only Alpaca REST call is used only to display a real
 * EOD reference price, never persisted, never fabricated when unavailable.
 *
 * Scope (explicit, this is Phase 1 of a much larger request, not the full system):
 *   1. Reuse the real discovery lineage (DISCOVERY_CANDIDATE_ADMITTED/FILTERED,
 *      NEWS_ANALYZED/NEWS_CLUSTER_CREATED) and missed_opportunities tables that already exist -
 *      no new database migrations, no new scanning infrastructure.
 *   2. Classify every distinct symbol the discovery layer touched today into an honest taxonomy
 *      grounded in what the data actually shows (never hardcodes a symbol list - discovers
 *      whatever the live system actually saw).
 *   3. Where a real Alpaca daily bar is available, report the actual price move since the first
 *      time Argus's own scanner saw the symbol today - real evidence, not a fabricated backtest.
 *
 * Explicitly NOT in this pass (flagged, not silently skipped): point-in-time minute-by-minute
 * reconstruction, strategy-level outcome attribution, research-hypothesis/backtest/promotion
 * pipeline, automatic scheduling. See the accompanying implementation note for the full,
 * larger request this is a bounded first slice of.
 *
 * Usage: npx tsx scripts/postmarket_missed_opportunity_report.ts [YYYY-MM-DD]
 */
import dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const REPO_ROOT = process.cwd();
const DB_PATH = process.env.ARGUS_DB_PATH || path.join(REPO_ROOT, 'data', 'argus.db');

type FilteredEvidence = {
  source: string; reason: string; price: number | null; dollarVolume: number | null;
  spreadBps: number | null; advShares: number | null; gapMover: boolean; gapPct: number | null;
  rvolMover: boolean; rvol: number | null;
};

type SymbolFinding = {
  symbol: string;
  firstSeenAtIso: string;
  admitted: boolean;
  filteredReasons: string[];
  firstEvidence: FilteredEvidence | null;
  lastEvidence: FilteredEvidence | null;
  hadNewsCoverage: boolean;
  missedOpportunityRow: {
    classification: string; classificationReason: string; rank: number | null; finalScore: number | null;
  } | null;
  classification: string;
  classificationRationale: string;
  priceAtFirstSeen: number | null;
  realEodClose: number | null;
  realEodChangePct: number | null;
  eodDataStatus: 'REAL' | 'UNAVAILABLE';
};

function classify(f: Omit<SymbolFinding, 'classification' | 'classificationRationale' | 'realEodClose' | 'realEodChangePct' | 'eodDataStatus' | 'priceAtFirstSeen'>): { classification: string; rationale: string } {
  if (f.missedOpportunityRow) {
    const c = f.missedOpportunityRow.classification;
    return { classification: c, rationale: f.missedOpportunityRow.classificationReason };
  }
  if (!f.admitted && f.filteredReasons.length > 0) {
    const reasons = new Set(f.filteredReasons);
    if (reasons.has('PRICE')) {
      return {
        classification: 'CORRECT_NON_ACTION',
        rationale: `Filtered on PRICE (below the deliberate minimum-price/penny-stock screen) at price ${f.lastEvidence?.price}. A move that happens after this filter fired is not a detection failure - the exclusion policy was applied correctly at scan time.`,
      };
    }
    if (reasons.has('ADV') && f.lastEvidence?.advShares == null) {
      return {
        classification: 'DATA_QUALITY_GAP',
        rationale: 'Filtered on ADV (average daily volume) but advShares was null - the liquidity gate correctly fails closed on missing data, but the underlying data fetch for this symbol did not succeed. Real, fixable gap: the data source, not the threshold.',
      };
    }
    if (reasons.has('ADV') || reasons.has('DOLLAR_VOLUME')) {
      return {
        classification: 'LIQUIDITY_EXCLUDED',
        rationale: `Filtered on ${[...reasons].join('/')} with a real, non-null measured value below the configured liquidity floor. A deliberate, evidenced exclusion, not a detection gap.`,
      };
    }
    if (reasons.has('SPREAD')) {
      return { classification: 'CORRECT_NON_ACTION', rationale: `Filtered on SPREAD (bid/ask too wide to trade safely) at ${f.lastEvidence?.spreadBps}bps.` };
    }
    return { classification: 'FILTERED_OTHER', rationale: `Filtered for reason(s): ${[...reasons].join(', ')}.` };
  }
  if (f.admitted) {
    return { classification: 'ADMITTED_NO_MISSED_OPP_ROW', rationale: 'Admitted as a discovery candidate but never reached the missed-opportunity table - likely subscribed and evaluated normally, or filtered later in a stage this report does not yet trace.' };
  }
  if (f.hadNewsCoverage) {
    return {
      classification: 'NEWS_BLIND_SPOT',
      rationale: 'NewsEngine analyzed a real story mentioning this symbol, but it never became a discovery candidate (no DISCOVERY_CANDIDATE_ADMITTED/FILTERED event at all) - a real, confirmed gap between news detection and discovery admission.',
    };
  }
  return {
    classification: 'TRUE_UNIVERSE_MISS',
    rationale: 'Zero discovery-lineage or news events found for this symbol today - it was never considered by any part of the pipeline this report can trace.',
  };
}

async function fetchRealEodBar(symbol: string, dateIso: string): Promise<{ open: number; close: number } | null> {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null;
  try {
    const start = `${dateIso}T00:00:00Z`;
    const end = `${dateIso}T23:59:59Z`;
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=5&adjustment=raw&feed=iex`;
    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const bars = data.bars || [];
    if (bars.length === 0) return null;
    const bar = bars[bars.length - 1];
    return { open: bar.o, close: bar.c };
  } catch {
    return null;
  }
}

async function main() {
  const dateArg = process.argv[2] || new Date().toISOString().slice(0, 10);
  const sinceMs = new Date(`${dateArg}T00:00:00.000Z`).getTime();
  const sinceIso = new Date(sinceMs).toISOString();

  const db = new Database(DB_PATH, { readonly: true });

  const discoveryEvents = db.prepare(`
    SELECT ts, symbol, event_type, payload
    FROM observability_events
    WHERE ts >= ? AND symbol IS NOT NULL
      AND event_type IN ('DISCOVERY_CANDIDATE_ADMITTED','DISCOVERY_CANDIDATE_FILTERED','NEWS_ANALYZED','NEWS_CLUSTER_CREATED')
    ORDER BY ts ASC
  `).all(sinceMs) as Array<{ ts: number; symbol: string; event_type: string; payload: string | null }>;

  const missedOpps = db.prepare(`
    SELECT symbol, classification, classification_reason, evidence_at_decision_json
    FROM missed_opportunities
    WHERE detected_at >= ?
  `).all(sinceIso) as Array<{ symbol: string; classification: string; classification_reason: string; evidence_at_decision_json: string | null }>;

  const bySymbol = new Map<string, {
    firstSeenAtMs: number; firstEvidence: FilteredEvidence | null; admitted: boolean; filteredReasons: string[]; lastEvidence: FilteredEvidence | null; hadNewsCoverage: boolean;
  }>();

  for (const ev of discoveryEvents) {
    if (!bySymbol.has(ev.symbol)) {
      bySymbol.set(ev.symbol, { firstSeenAtMs: ev.ts, firstEvidence: null, admitted: false, filteredReasons: [], lastEvidence: null, hadNewsCoverage: false });
    }
    const entry = bySymbol.get(ev.symbol)!;
    if (ev.event_type === 'DISCOVERY_CANDIDATE_ADMITTED') entry.admitted = true;
    if (ev.event_type === 'DISCOVERY_CANDIDATE_FILTERED' && ev.payload) {
      try {
        const parsed = JSON.parse(ev.payload);
        const evidence: FilteredEvidence = parsed.reason ? parsed : parsed.payload;
        if (evidence?.reason) {
          entry.filteredReasons.push(evidence.reason);
          // firstEvidence is set once, on the earliest FILTERED event seen for this symbol - this
          // is what "price at first seen" honestly means. lastEvidence (most recent snapshot) is
          // kept separately for the classification reason text, since a symbol's LATEST filter
          // reason is more relevant to "why is it excluded right now" than its first one.
          if (!entry.firstEvidence) entry.firstEvidence = evidence;
          entry.lastEvidence = evidence;
        }
      } catch { /* real payload malformed - skip, never fabricate a reason */ }
    }
    if (ev.event_type === 'NEWS_ANALYZED' || ev.event_type === 'NEWS_CLUSTER_CREATED') entry.hadNewsCoverage = true;
  }

  const missedOppBySymbol = new Map<string, { classification: string; classificationReason: string; rank: number | null; finalScore: number | null }>();
  for (const m of missedOpps) {
    if (missedOppBySymbol.has(m.symbol)) continue; // first (earliest) record per symbol
    let rank: number | null = null, finalScore: number | null = null;
    try {
      const ev = JSON.parse(m.evidence_at_decision_json || '{}');
      rank = ev.rank ?? null;
      finalScore = ev.finalScore ?? null;
    } catch { /* real evidence JSON malformed - leave null, never fabricate */ }
    missedOppBySymbol.set(m.symbol, { classification: m.classification, classificationReason: m.classification_reason, rank, finalScore });
  }

  const allSymbols = new Set<string>([...bySymbol.keys(), ...missedOppBySymbol.keys()]);
  const findings: SymbolFinding[] = [];

  for (const symbol of allSymbols) {
    const disc = bySymbol.get(symbol);
    const missedRow = missedOppBySymbol.get(symbol) ?? null;
    const base = {
      symbol,
      firstSeenAtIso: disc ? new Date(disc.firstSeenAtMs).toISOString() : sinceIso,
      admitted: disc?.admitted ?? true, // a missed_opportunities-only row was, by definition, admitted/subscribed at some point
      filteredReasons: disc?.filteredReasons ?? [],
      firstEvidence: disc?.firstEvidence ?? null,
      lastEvidence: disc?.lastEvidence ?? null,
      hadNewsCoverage: disc?.hadNewsCoverage ?? false,
      missedOpportunityRow: missedRow,
    };
    const { classification, rationale } = classify(base);

    // Honestly "price at first seen", not the most recent snapshot - the two can differ
    // materially intraday (confirmed live: TNON's first snapshot was $2.49, its later snapshot
    // was $5.54 after already moving).
    const priceAtFirstSeen = base.firstEvidence?.price ?? null;
    let realEodClose: number | null = null, realEodChangePct: number | null = null;
    let eodDataStatus: 'REAL' | 'UNAVAILABLE' = 'UNAVAILABLE';
    if (priceAtFirstSeen != null) {
      const bar = await fetchRealEodBar(symbol, dateArg);
      if (bar) {
        realEodClose = bar.close;
        realEodChangePct = ((bar.close - priceAtFirstSeen) / priceAtFirstSeen) * 100;
        eodDataStatus = 'REAL';
      }
    }

    findings.push({ ...base, classification, classificationRationale: rationale, priceAtFirstSeen, realEodClose, realEodChangePct, eodDataStatus });
  }

  findings.sort((a, b) => Math.abs(b.realEodChangePct ?? 0) - Math.abs(a.realEodChangePct ?? 0));

  const summary = {
    date: dateArg,
    totalSymbolsTouched: findings.length,
    byClassification: findings.reduce((acc, f) => { acc[f.classification] = (acc[f.classification] ?? 0) + 1; return acc; }, {} as Record<string, number>),
  };

  console.log(JSON.stringify(summary, null, 2));

  const outDir = path.join(REPO_ROOT, 'docs', 'audits');
  fs.writeFileSync(path.join(outDir, `postmarket_missed_opportunity_findings_${dateArg}.json`), JSON.stringify({ summary, findings }, null, 2));

  const html = renderHtml(dateArg, summary, findings);
  fs.writeFileSync(path.join(outDir, `argus_postmarket_${dateArg}.html`), html);

  db.close();
  console.log(`\nWritten: docs/audits/argus_postmarket_${dateArg}.html`);
  console.log(`Written: docs/audits/postmarket_missed_opportunity_findings_${dateArg}.json`);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(dateArg: string, summary: any, findings: SymbolFinding[]): string {
  const rows = findings.map((f) => {
    const changeStr = f.realEodChangePct != null ? `${f.realEodChangePct >= 0 ? '+' : ''}${f.realEodChangePct.toFixed(1)}%` : 'UNKNOWN — no real EOD data';
    const changeColor = f.realEodChangePct == null ? '#6e7681' : f.realEodChangePct >= 0 ? '#3fb950' : '#f85149';
    return `<tr>
      <td><b>${esc(f.symbol)}</b></td>
      <td><span class="tag">${esc(f.classification)}</span></td>
      <td style="color:${changeColor}">${changeStr}</td>
      <td>${f.priceAtFirstSeen != null ? '$' + f.priceAtFirstSeen.toFixed(2) : '—'}</td>
      <td>${f.realEodClose != null ? '$' + f.realEodClose.toFixed(2) : '—'}</td>
      <td style="max-width:420px">${esc(f.classificationRationale)}</td>
    </tr>`;
  }).join('\n');

  const classCounts = Object.entries(summary.byClassification)
    .map(([k, v]) => `<div class="tile"><div class="label">${esc(k)}</div><div class="value">${v}</div></div>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>ARGUS Postmarket Report — ${dateArg}</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#2a3038; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:0 0 60px; }
  header { background:linear-gradient(135deg,#161b22,#0d1117); border-bottom:1px solid var(--border); padding:26px 40px; }
  header h1 { margin:0 0 6px; font-size:21px; }
  header .sub { color:var(--muted); font-size:13px; }
  main { max-width:1180px; margin:0 auto; padding:28px 40px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:0.5px; color:var(--accent); border-bottom:1px solid var(--border); padding-bottom:9px; margin:30px 0 16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:10px; }
  .tile { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .tile .label { font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:5px; }
  .tile .value { font-size:22px; font-weight:700; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--muted); text-transform:uppercase; font-size:11px; }
  .tbl-wrap { overflow-x:auto; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:4px 8px; }
  .tag { display:inline-block; padding:2px 9px; border-radius:12px; font-size:11px; font-weight:700; background:rgba(88,166,255,0.15); color:var(--accent); }
  .callout { background:rgba(88,166,255,0.08); border:1px solid rgba(88,166,255,0.3); border-radius:8px; padding:14px 18px; margin:14px 0; font-size:13px; }
  footer { max-width:1180px; margin:0 auto; padding:18px 40px; color:var(--muted); font-size:12px; border-top:1px solid var(--border); }
</style></head>
<body>
<header>
  <h1>ARGUS — Postmarket Missed-Opportunity Report</h1>
  <div class="sub">${dateArg} · Phase 1 (scoped) · Real discovery-lineage + missed_opportunities data, no fabricated symbols or classifications</div>
</header>
<main>
  <div class="callout">This is <b>Phase 1</b> of a much larger requested system — it reuses existing discovery-lineage/missed-opportunity data (no new scanning infrastructure yet) and reports a real, honest classification for every symbol the live pipeline actually touched today. It does not yet do point-in-time minute-by-minute reconstruction, strategy-level outcome attribution, or automated scheduling — see the accompanying implementation note for what's deferred.</div>
  <h2>Classification Summary</h2>
  <div class="grid">${classCounts}</div>
  <h2>Every Symbol The Pipeline Touched Today (${findings.length})</h2>
  <div class="tbl-wrap"><table>
    <tr><th>Symbol</th><th>Classification</th><th>Real move since first seen</th><th>Price at first seen</th><th>Real EOD close</th><th>Rationale</th></tr>
    ${rows}
  </table></div>
</main>
<footer>Real EOD close prices fetched read-only from Alpaca's public bars endpoint, never persisted, never fabricated when unavailable. Generated by scripts/postmarket_missed_opportunity_report.ts.</footer>
</body></html>`;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
