/**
 * Research replay panel. AI historical replay is shown as UNAVAILABLE with a real explanation.
 * Quant-strategy replay reuses POST /api/v2/replay/historical → BacktestEngine + ReplayClock.
 */
import React, { useEffect, useState } from 'react';
import { History, AlertTriangle } from 'lucide-react';

export default function ReplayResearchPanel() {
  const [ai, setAi] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [form, setForm] = useState({
    strategyId: 'MOMENTUM_BREAKOUT',
    symbol: 'AAPL',
    startDate: '2022-01-01',
    endDate: '2022-12-31',
    initialCash: '2000',
  });

  useEffect(() => {
    fetch('/api/v2/replay/ai-availability')
      .then(r => r.json())
      .then(j => setAi(j.data || j))
      .catch(e => setAi({ available: false, why: e.message, what: 'AI replay status', impact: 'Panel could not load availability.', fix: 'Confirm the API is reachable.', severity: 'WARNING' }));
  }, []);

  async function runQuant() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/v2/replay/historical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'QUANT_STRATEGY',
          strategyId: form.strategyId,
          symbol: form.symbol.toUpperCase(),
          startDate: form.startDate,
          endDate: form.endDate,
          initialCash: Number(form.initialCash),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.ok === false) {
        setError(json.error || json.diagnostic?.userMessage || 'Replay failed');
        return;
      }
      setResult(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
      <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
        <History size={18} className="text-indigo-400" />
        Historical replay (research)
      </h2>
      <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mb-4">
        ReplayClock OHLCV only — AI consensus is not reconstructed
      </p>

      {ai && (
        <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-3 mb-4 text-xs text-amber-100/90 space-y-1">
          <div className="flex items-center gap-2 font-bold text-amber-300">
            <AlertTriangle size={14} /> {ai.what || 'AI historical replay'}
          </div>
          <div><span className="text-slate-500">WHY:</span> {ai.why}</div>
          <div><span className="text-slate-500">IMPACT:</span> {ai.impact}</div>
          <div><span className="text-slate-500">FIX:</span> {ai.fix}</div>
          <div className="text-slate-400">{ai.alternative}</div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
        {(['strategyId', 'symbol', 'startDate', 'endDate', 'initialCash'] as const).map(key => (
          <label key={key} className="text-[9px] font-mono text-slate-500 uppercase tracking-widest">
            {key}
            <input
              className="mt-1 w-full bg-[#0A0F16] border border-slate-700 rounded px-2 py-1.5 text-xs text-white"
              value={(form as any)[key]}
              onChange={e => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={runQuant}
        className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest bg-indigo-600/80 hover:bg-indigo-500 text-white rounded disabled:opacity-40"
      >
        {busy ? 'Running…' : 'Run quant ReplayClock'}
      </button>
      {error && <div className="mt-3 text-xs text-rose-400">{error}</div>}
      {result?.metrics && (
        <div className="mt-4 text-[10px] font-mono text-slate-400 grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>Trades {result.metrics.totalTrades}</div>
          <div>Win% {result.metrics.winRatePct}</div>
          <div>PF {result.metrics.profitFactor}</div>
          <div>MaxDD {result.metrics.maxDrawdownPct}</div>
        </div>
      )}
      {result?.overconfidence && (
        <div className="mt-3 text-[11px] text-slate-300">
          {result.overconfidence.note}
          <div className="text-slate-500 mt-1">{result.overconfidence.aiConfidenceLossesReason}</div>
        </div>
      )}
      {Array.isArray(result?.ledger) && result.ledger.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-[10px] font-mono text-slate-300">
            <thead className="text-slate-500 uppercase">
              <tr>
                <th className="text-left py-1">Exit</th>
                <th className="text-left">Entry</th>
                <th className="text-left">Exit px</th>
                <th className="text-left">P&L</th>
                <th className="text-left">Result</th>
                <th className="text-left">Pred vs actual</th>
              </tr>
            </thead>
            <tbody>
              {result.ledger.slice(0, 40).map((row: any, i: number) => (
                <tr key={i} className="border-t border-slate-800">
                  <td className="py-1">{row.exitTime?.slice(0, 10)}</td>
                  <td>{Number(row.entry).toFixed(2)}</td>
                  <td>{Number(row.exit).toFixed(2)}</td>
                  <td className={row.result === 'WIN' ? 'text-emerald-400' : row.result === 'LOSS' ? 'text-rose-400' : ''}>
                    {row.pnl}
                  </td>
                  <td>{row.result}</td>
                  <td>{row.predictionCorrect === true ? 'CORRECT' : row.predictionCorrect === false ? 'INCORRECT' : 'N/A'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
