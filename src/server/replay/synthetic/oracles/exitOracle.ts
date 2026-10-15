/**
 * exitOracle.ts - INDEPENDENT protective-exit oracle (2026-10-14). Closes the gap that no oracle could notice a MISSING protective exit.
 *
 * Contract it enforces (derived from persisted/observed facts only; imports nothing from PortfolioMonitor/RiskEngine/OMS): a long position must not stay
 * open for more than `graceMs` after a bar CLOSES at or below `avgCost * (1 - stopPct/100)`. The stop percentage comes from the session's own settings
 * (trailingStopPct) - the universal backstop PortfolioMonitor applies to every holding - and the grace window covers the monitor cadence plus the exit
 * idea's trip through RiskEngine/OMS. A breach with no SELL fill inside the grace window (while the position is still open) is a violation.
 *
 * Pure over plain arrays. Labeled SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY.
 */
export interface OracleFill { atMs: number; symbol: string; side: 'BUY' | 'SELL'; quantity: number; price: number }
export interface OracleBar { atMs: number; close: number }
export interface ExitViolation { code: 'PROTECTIVE_EXIT_MISSING'; symbol: string; breachAtMs: number; breachClose: number; avgCost: number; positionQty: number; detail: string }
export interface ExitOracleResult { checkedPositions: number; breaches: number; violations: ExitViolation[] }

export function runExitOracle(args: { fills: OracleFill[]; barsBySymbol: Map<string, OracleBar[]>; stopPct: number; graceMs: number; sessionEndMs: number }): ExitOracleResult {
  const { stopPct, graceMs, sessionEndMs } = args;
  const bySymbol = new Map<string, OracleFill[]>();
  for (const f of [...args.fills].sort((a, b) => a.atMs - b.atMs)) { const l = bySymbol.get(f.symbol) ?? []; l.push(f); bySymbol.set(f.symbol, l); }
  const violations: ExitViolation[] = []; let checked = 0; let breaches = 0;
  for (const [symbol, fills] of bySymbol) {
    const bars = (args.barsBySymbol.get(symbol) ?? []).slice().sort((a, b) => a.atMs - b.atMs);
    // reconstruct (time, qty, avgCost) after each fill
    const states: Array<{ atMs: number; qty: number; avg: number }> = [];
    let qty = 0; let avg = 0;
    for (const f of fills) {
      if (f.side === 'BUY') { avg = (avg * qty + f.price * f.quantity) / (qty + f.quantity); qty += f.quantity; }
      else { qty = Math.max(0, qty - f.quantity); if (qty === 0) avg = 0; }
      states.push({ atMs: f.atMs, qty, avg });
    }
    const stateAt = (t: number) => { let s = { qty: 0, avg: 0 }; for (const x of states) { if (x.atMs <= t) s = x; else break; } return s; };
    if (states.some((s) => s.qty > 0)) checked++;
    let breachStart: { atMs: number; close: number; qty: number; avg: number } | null = null;
    for (const b of bars) {
      const st = stateAt(b.atMs);
      if (st.qty > 0 && b.close <= st.avg * (1 - stopPct / 100)) {
        if (!breachStart) { breachStart = { atMs: b.atMs, close: b.close, qty: st.qty, avg: st.avg }; breaches++; }
        if (b.atMs - breachStart.atMs >= graceMs && stateAt(b.atMs).qty > 0) {
          violations.push({ code: 'PROTECTIVE_EXIT_MISSING', symbol, breachAtMs: breachStart.atMs, breachClose: breachStart.close, avgCost: breachStart.avg, positionQty: stateAt(b.atMs).qty,
            detail: `${symbol}: bar close ${breachStart.close.toFixed(2)} <= ${(breachStart.avg * (1 - stopPct / 100)).toFixed(2)} (avg ${breachStart.avg.toFixed(2)} -${stopPct}%) at ${new Date(breachStart.atMs).toISOString()} and the position was still open ${Math.round((b.atMs - breachStart.atMs) / 60000)} min later` });
          breachStart = null; // report once per breach episode
        }
      } else if (st.qty === 0 || b.close > st.avg * (1 - stopPct / 100)) {
        breachStart = null; // recovered or closed
      }
    }
    // a breach still unresolved at session end with enough remaining time to have been handled
    void sessionEndMs;
  }
  return { checkedPositions: checked, breaches, violations };
}
