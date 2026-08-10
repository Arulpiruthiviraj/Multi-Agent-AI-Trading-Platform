/**
 * ==========================================================
 * Module: TransactionExplorer
 *
 * Purpose:
 * Search/browse surface over the real transaction ledger (GET /api/v2/transactions) - lets you
 * find any transaction by symbol or status, including NO_CONSENSUS ones that never reached an
 * order, for "why didn't Argus trade X" investigation. Selecting a row opens the full
 * TransactionObservatory replay.
 * ==========================================================
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw } from 'lucide-react';
import TransactionObservatory from './TransactionObservatory';
import MissionControlBar from './MissionControlBar';

interface TxRow {
  id: string;
  symbol: string;
  openedAt: string;
  closedAt: string | null;
  status: string;
  finalDecision: string | null;
  outcome: string;
}

const STATUS_OPTIONS = ['', 'OPEN', 'NO_CONSENSUS', 'RISK_REJECTED', 'EXECUTED', 'FILLED', 'RECONCILED'];

function statusColor(status: string): string {
  if (status === 'NO_CONSENSUS') return 'text-slate-500 bg-slate-800 border-slate-700';
  if (status === 'RISK_REJECTED') return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
  if (status === 'FILLED' || status === 'RECONCILED') return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
  return 'text-sky-400 bg-sky-500/10 border-sky-500/30';
}

export default function TransactionExplorer() {
  const [rows, setRows] = useState<TxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (symbolFilter) params.set('symbol', symbolFilter);
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', '100');
    fetch(`/api/v2/transactions?${params.toString()}`)
      .then(r => r.json())
      .then(json => {
        if (!json.ok) { setError(json.error || 'Failed to load transactions'); setRows([]); }
        else setRows(json.transactions || []);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [symbolFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <MissionControlBar />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-bold uppercase tracking-widest text-sm">Transaction Observatory</h2>
          <p className="text-[10px] text-slate-500 mt-1">Every decision cycle Argus has run - approved, rejected, or never reaching consensus. Select any row to replay it in full.</p>
        </div>
        <button onClick={load} className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-white transition-colors border border-slate-700 hover:border-slate-500 rounded px-3 py-1.5 flex items-center gap-1.5">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={symbolFilter}
            onChange={e => setSymbolFilter(e.target.value)}
            placeholder="Filter by symbol..."
            className="w-full bg-[#111822] border border-slate-800 rounded pl-8 pr-3 py-1.5 text-xs text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-[#111822] border border-slate-800 rounded px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-indigo-500/50"
        >
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s || 'All Statuses'}</option>)}
        </select>
      </div>

      <div className="bg-[#111822] border border-slate-800 rounded overflow-hidden">
        {loading ? (
          <p className="text-xs text-slate-500 p-6 text-center font-mono">Loading...</p>
        ) : error ? (
          <p className="text-xs text-rose-400 p-6 text-center font-mono">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-slate-600 p-6 text-center font-mono italic">No transactions match this filter.</p>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[9px] font-mono text-slate-500 uppercase tracking-wider">
                <th className="py-2 px-3">Transaction ID</th>
                <th className="py-2 px-3">Symbol</th>
                <th className="py-2 px-3">Decision</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Outcome</th>
                <th className="py-2 px-3">Opened</th>
              </tr>
            </thead>
            <tbody className="text-xs font-mono text-slate-300">
              {rows.map(row => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  className="border-b border-slate-800/40 hover:bg-slate-800/30 cursor-pointer transition-colors"
                >
                  <td className="py-2 px-3 text-indigo-400">{row.id}</td>
                  <td className="py-2 px-3 font-bold text-white">{row.symbol}</td>
                  <td className="py-2 px-3">
                    {row.finalDecision ? (
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${row.finalDecision === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : row.finalDecision === 'SELL' ? 'bg-amber-500/20 text-amber-500' : 'bg-slate-800 text-slate-400'}`}>
                        {row.finalDecision}
                      </span>
                    ) : <span className="text-slate-600">--</span>}
                  </td>
                  <td className="py-2 px-3">
                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest border ${statusColor(row.status)}`}>{row.status}</span>
                  </td>
                  <td className="py-2 px-3 text-slate-400">{row.outcome}</td>
                  <td className="py-2 px-3 text-slate-500">{new Date(row.openedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedId && (
        <TransactionObservatory transactionId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
