/**
 * Historical Replay Lab — MODE B full Argus replay. Not VectorBT. Not LIVE. Not paper.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, AlertTriangle, Play, Pause, Square, StepForward, Download } from 'lucide-react';

const CAPITAL_PRESETS = [100, 1000, 10000, 100000];

export default function HistoricalReplayLab() {
  const [providers, setProviders] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [equity, setEquity] = useState<any[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [form, setForm] = useState({
    startDate: '2024-01-02',
    endDate: '2024-06-28',
    startTime: '09:30:00',
    endTime: '16:00:00',
    market: 'US',
    exchange: 'NYSE',
    timezone: 'America/New_York',
    symbols: 'AAPL',
    frequency: '1Day',
    dataProvider: 'golden_replay',
    initialCapital: '100000',
    allocationBudget: '3000',
    costProfile: 'Base',
    aiMode: 'DISABLED',
    strategyIds: 'MOMENTUM_BREAKOUT',
    shortSelling: false,
    fractionalShares: false,
    extendedHours: false,
    speed: 'MAX',
  });

  useEffect(() => {
    fetch('/api/v2/research/replay/providers')
      .then((r) => r.json())
      .then((j) => setProviders(j.providers || []))
      .catch((e) => setError(e.message));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const refreshRun = useCallback(async (replayId: string) => {
    const [status, tradesRes, eventsRes, equityRes] = await Promise.all([
      fetch(`/api/v2/research/replay/${replayId}`).then((r) => r.json()),
      fetch(`/api/v2/research/replay/${replayId}/trades`).then((r) => r.json()).catch(() => ({ trades: [] })),
      fetch(`/api/v2/research/replay/${replayId}/events`).then((r) => r.json()).catch(() => ({ events: [] })),
      fetch(`/api/v2/research/replay/${replayId}/equity`).then((r) => r.json()).catch(() => ({ equity: [] })),
    ]);
    setRun(status);
    setTrades(tradesRes.trades || status.trades || []);
    setEvents((eventsRes.events || status.events || []).slice(-80));
    setEquity(equityRes.equity || status.equity || []);
    return status;
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(replayId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await refreshRun(replayId);
        if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DATA_UNAVAILABLE'].includes(status.status)) {
          stopPolling();
          setBusy(false);
        }
      } catch {
        /* keep polling briefly */
      }
    }, 750);
  }

  async function loadValidate() {
    setBusy(true);
    setError(null);
    try {
      const symbols = form.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const results = [];
      for (const symbol of symbols) {
        const r = await fetch('/api/v2/research/datasets/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: form.dataProvider,
            symbol,
            frequency: form.frequency,
            startDate: form.startDate,
            endDate: form.endDate,
          }),
        }).then((x) => x.json());
        results.push(r);
      }
      const red = results.find((r) => r.quality?.quality === 'RED' || r.ok === false);
      if (red && red.ok === false) setError(red.error || red.code || 'DATA_UNAVAILABLE');
      else setRun({
        status: 'DATA_LOADED',
        quality: results[0]?.quality,
        datasetPreview: results,
        live: 'NO-GO',
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function createAndStart(asyncMode = true) {
    setBusy(true);
    setError(null);
    setRun(null);
    setTrades([]);
    setEvents([]);
    setEquity([]);
    try {
      const created = await fetch('/api/v2/research/replay/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          symbols: form.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
          strategyIds: form.strategyIds.split(',').map((s) => s.trim()).filter(Boolean),
          initialCapital: Number(form.initialCapital),
          allocationBudget: Number(form.allocationBudget),
          maxPositionSize: Number(form.allocationBudget),
          randomSeed: 1,
        }),
      }).then((r) => r.json());
      if (!created.ok && created.status === 'DATA_UNAVAILABLE') {
        setError(created.error || created.code);
        setRun(created);
        setBusy(false);
        return;
      }
      if (created.error && created.status === 'FAILED') {
        setError(created.error);
        setRun(created);
        setBusy(false);
        return;
      }
      setRun(created);
      const started = await fetch(`/api/v2/research/replay/${created.replayId}/start?async=${asyncMode ? '1' : '0'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ async: asyncMode }),
      }).then((r) => r.json());
      if (started.error && started.ok === false) {
        setError(started.error);
        setBusy(false);
        return;
      }
      if (asyncMode) {
        startPolling(created.replayId);
        await refreshRun(created.replayId);
      } else {
        setRun(started);
        setTrades(started.trades || []);
        setEvents(started.events || []);
        setEquity(started.equity || []);
        setBusy(false);
      }
      if (started.error) setError(started.error);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  const report = run?.report;
  const qualityLabel = run?.quality?.quality
    ? `DATA QUALITY: ${run.quality.quality}${run.quality.quality === 'RED' ? ' — REPLAY BLOCKED' : ''}`
    : 'DATA QUALITY: NOT RUN';

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6" id="historical-replay-lab">
      <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
        <History size={18} className="text-amber-400" />
        Historical Replay Lab
      </h2>
      <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">
        HISTORICAL REPLAY · SIMULATION ONLY · NOT LIVE · NOT PAPER · NOT ACTUAL TRADING
      </p>
      <p className="text-xs text-slate-400 mb-4">
        MODE B runs Quant → ChiefTrader vote math → RiskEngine → OMS → HistoricalReplayBroker.
        Execution model NEXT_BAR_OPEN. VectorBT remains MODE A research and cannot place orders.
      </p>

      <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 mb-4 text-[11px] text-amber-100/90 space-y-1">
        <div className="flex items-center gap-2 font-bold text-amber-300">
          <AlertTriangle size={14} /> Honesty
        </div>
        <div>AI mode DISABLED does not invent historical LLM votes. UNAVAILABLE agents stay UNAVAILABLE.</div>
        <div>Replay fills never count as organic paper. Promotion stays evidence-derived. LIVE remains NO-GO from this lab.</div>
        <div>ZERO_COST_RESEARCH results are theoretical and not live-readiness evidence.</div>
        <div>SURVIVORSHIP_BIAS_WARNING if the universe is operator-selected (not a historical constituent list).</div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-[9px] font-mono text-slate-500 uppercase">Initial capital</span>
        {CAPITAL_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setForm({ ...form, initialCapital: String(c) })}
            className={`px-2 py-1 text-[10px] font-mono rounded border ${Number(form.initialCapital) === c ? 'border-indigo-500 text-indigo-300' : 'border-slate-700 text-slate-400'}`}
          >
            ${c.toLocaleString()}
          </button>
        ))}
        <label className="text-[9px] font-mono text-slate-500 uppercase">
          Custom
          <input
            className="ml-2 w-24 bg-[#0A0F16] border border-slate-700 rounded px-2 py-1 text-xs text-white"
            value={form.initialCapital}
            onChange={(e) => setForm({ ...form, initialCapital: e.target.value })}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        {(['startDate', 'endDate', 'startTime', 'endTime', 'market', 'exchange', 'timezone', 'symbols', 'frequency', 'dataProvider', 'allocationBudget', 'costProfile', 'aiMode', 'strategyIds', 'speed'] as const).map((key) => (
          <label key={key} className="text-[9px] font-mono text-slate-500 uppercase tracking-widest">
            {key}
            {key === 'costProfile' ? (
              <select
                className="mt-1 w-full bg-[#0A0F16] border border-slate-700 rounded px-2 py-1.5 text-xs text-white"
                value={form.costProfile}
                onChange={(e) => setForm({ ...form, costProfile: e.target.value })}
              >
                {['Base', 'Optimistic', 'Conservative', 'ZERO_COST_RESEARCH', 'REALISTIC_COST', 'CUSTOM_COST'].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            ) : (
              <input
                className="mt-1 w-full bg-[#0A0F16] border border-slate-700 rounded px-2 py-1.5 text-xs text-white"
                value={(form as any)[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      <div className="flex gap-4 text-[10px] font-mono text-slate-400 mb-3">
        <label><input type="checkbox" checked={form.shortSelling} onChange={(e) => setForm({ ...form, shortSelling: e.target.checked })} /> Short selling</label>
        <label><input type="checkbox" checked={form.fractionalShares} onChange={(e) => setForm({ ...form, fractionalShares: e.target.checked })} /> Fractional</label>
        <label><input type="checkbox" checked={form.extendedHours} onChange={(e) => setForm({ ...form, extendedHours: e.target.checked })} /> Extended hours</label>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button type="button" disabled={busy} onClick={loadValidate} className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest bg-slate-800 text-slate-200 rounded disabled:opacity-40">
          Load / Validate data
        </button>
        <button type="button" disabled={busy} onClick={() => createAndStart(true)} className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest bg-indigo-600/80 hover:bg-indigo-500 text-white rounded disabled:opacity-40 flex items-center gap-1">
          <Play size={12} /> {busy ? 'Running…' : 'Run historical replay'}
        </button>
        {run?.replayId && (
          <>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/pause`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Pause size={12} /> Pause</button>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/resume`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded">Resume</button>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/step`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><StepForward size={12} /> Step</button>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/stop`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Square size={12} /> Stop</button>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=json`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> JSON</a>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=jsonl`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> JSONL</a>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=csv&kind=trades`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> CSV</a>
          </>
        )}
      </div>

      <div className="text-[10px] font-mono text-slate-400 mb-3">{qualityLabel}</div>

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Data providers</h3>
      <div className="overflow-x-auto mb-4">
        <table className="w-full text-[10px] font-mono text-slate-300">
          <thead className="text-slate-500"><tr><th className="text-left">Id</th><th className="text-left">Availability</th><th className="text-left">Auth</th><th className="text-left">Note</th></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} className="border-t border-slate-800">
                <td className="py-1">{p.id}</td>
                <td>{p.availability}</td>
                <td>{p.authenticationStatus}</td>
                <td className="text-slate-500">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <div className="text-xs text-rose-400 mb-3">{error}</div>}

      {run && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono text-slate-400 mb-3">
          <div>Status {run.status || 'NOT RUN'}</div>
          <div>Quality {run.quality?.quality || 'n/a'}</div>
          <div>ReplayHash {String(run.replayHash || run.hashes?.replayHash || '').slice(0, 18) || '—'}</div>
          <div>Promotion {run.promotion?.status || 'UNTESTED'}</div>
          <div>AI {run.ai?.mode || run.aiLabel || form.aiMode}</div>
          <div>Exec {run.executionModel || report?.executionModel || 'NEXT_BAR_OPEN'}</div>
          <div>Initial {report?.startingCapital ?? form.initialCapital}</div>
          <div>Final {report?.endingCapital ?? '—'}</div>
          <div>Net {report?.netPnl ?? '—'}</div>
          <div>Return% {report?.netReturnPct != null ? Number(report.netReturnPct).toFixed(3) : '—'}</div>
          <div>Sharpe {report?.sharpe?.status || '—'}</div>
          <div>Sortino {report?.sortino?.status || '—'}</div>
          <div>Exposure {report?.exposure?.value ?? report?.exposure?.status ?? '—'}</div>
          <div>Turnover {report?.turnover?.value ?? report?.turnover?.status ?? '—'}</div>
        </div>
      )}

      {report?.zeroCostWarning && (
        <div className="mb-3 text-[10px] text-amber-300 font-mono">{report.zeroCostWarning}</div>
      )}

      {report?.honesty && (
        <ul className="text-[10px] text-slate-500 list-disc pl-4 space-y-1 mb-3">
          {report.honesty.map((h: string, i: number) => <li key={i}>{h}</li>)}
        </ul>
      )}

      {run?.agentAvailability && (
        <div className="mb-4">
          <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Agent availability</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-[10px] font-mono text-slate-400">
            {Object.entries(run.agentAvailability).map(([k, v]: any) => (
              <div key={k}>{k}: {v.status} — {v.reason}</div>
            ))}
          </div>
        </div>
      )}

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Trades</h3>
      <div className="overflow-x-auto mb-4 max-h-48 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="text-[10px] text-slate-500">NO DATA</div>
        ) : (
          <table className="w-full text-[10px] font-mono text-slate-300">
            <thead className="text-slate-500 sticky top-0 bg-[#1A1F2B]">
              <tr>
                <th className="text-left">Time</th>
                <th className="text-left">Symbol</th>
                <th className="text-left">Action</th>
                <th className="text-left">Qty</th>
                <th className="text-left">Price</th>
                <th className="text-left">Strategy</th>
                <th className="text-left">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={t.traceId || i} className="border-t border-slate-800">
                  <td className="py-1">{t.timestamp}</td>
                  <td>{t.symbol}</td>
                  <td>{t.side}</td>
                  <td>{t.quantity}</td>
                  <td>{t.price}</td>
                  <td>{t.strategyId}</td>
                  <td>{t.realizedPnl ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Equity curve ({equity.length || 0} pts)</h3>
      <div className="text-[10px] font-mono text-slate-400 mb-4">
        {equity.length === 0 ? 'NO DATA' : `First ${equity[0]?.equity} → Last ${equity[equity.length - 1]?.equity}`}
      </div>

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Event timeline (tail)</h3>
      <div className="overflow-x-auto max-h-40 overflow-y-auto mb-3">
        {events.length === 0 ? (
          <div className="text-[10px] text-slate-500">NO DATA</div>
        ) : (
          <ul className="text-[10px] font-mono text-slate-400 space-y-0.5">
            {events.map((e, i) => (
              <li key={e.eventId || i}>{e.historicalTimestamp} {e.type} {e.symbol || ''} {e.payload?.side || e.payload?.reason || ''}</li>
            ))}
          </ul>
        )}
      </div>

      {run?.noTrade && (
        <div className="mt-3 text-[10px] font-mono text-slate-400">
          NO_TRADE counts: {JSON.stringify(run.report?.noTrade || run.noTrade || {})}
        </div>
      )}
    </div>
  );
}
