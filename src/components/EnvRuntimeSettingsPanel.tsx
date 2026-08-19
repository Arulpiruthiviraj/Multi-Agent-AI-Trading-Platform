/**
 * Settings → Dual configuration (.env bootstrap + DB overlay).
 * Does not arm LIVE, write .env, or bypass RiskEngine/OMS.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type EffectiveRow = {
  setting: string;
  label: string;
  category: string;
  type: string;
  description: string;
  effectiveValue: string | boolean | number | null;
  envValue: string | null;
  dbOverride: string | boolean | number | null;
  source: 'SETTINGS' | 'ENV' | 'DEFAULT';
  overridable: boolean;
  safetyLocked: boolean;
  secret: boolean;
  applyMode: string;
  restartRequired: boolean;
  configured?: boolean;
};

function sourceLabel(source: EffectiveRow['source']): string {
  if (source === 'SETTINGS') return 'Settings Override';
  if (source === 'ENV') return '.env';
  return 'Safe default';
}

function formatValue(row: EffectiveRow, which: 'effective' | 'env' | 'db'): string {
  if (row.secret) {
    if (which === 'effective' || which === 'env') return row.configured ? 'Configured ✓' : 'Missing';
    return '—';
  }
  const v = which === 'effective' ? row.effectiveValue : which === 'env' ? row.envValue : row.dbOverride;
  if (v === null || v === undefined || v === '') return which === 'env' && row.envValue === null ? '(unset)' : '—';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return String(v);
}

export function EnvRuntimeSettingsPanel() {
  const [rows, setRows] = useState<EffectiveRow[]>([]);
  const [resetPhrase, setResetPhrase] = useState('RESET_ALL_TO_ENV');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/v2/settings/effective');
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
    setRows(Array.isArray(json.settings) ? json.settings : []);
    if (typeof json.resetAllConfirmation === 'string') setResetPhrase(json.resetAllConfirmation);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, EffectiveRow[]>();
    for (const row of rows) {
      const list = map.get(row.category) || [];
      list.push(row);
      map.set(row.category, list);
    }
    return map;
  }, [rows]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const setOverride = (row: EffectiveRow, value: unknown) =>
    run(row.setting, async () => {
      const res = await fetch('/api/v2/settings/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: row.setting, value }),
      });
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
    });

  const resetOne = (row: EffectiveRow) =>
    run(`reset-${row.setting}`, async () => {
      const res = await fetch(`/api/v2/settings/overrides/${encodeURIComponent(row.setting)}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
    });

  const resetAll = () =>
    run('reset-all', async () => {
      const res = await fetch('/api/v2/settings/overrides/reset-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirmAll }),
      });
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
      setConfirmAll('');
    });

  const exportJson = () =>
    run('export', async () => {
      const res = await fetch('/api/v2/settings/effective/export');
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'argus-effective-config-redacted.json';
      a.click();
      URL.revokeObjectURL(url);
    });

  return (
    <div className="bg-[#0F141C] border border-slate-800 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-mono font-bold text-slate-100 uppercase tracking-widest">Dual configuration · .env + Settings overlay</h3>
          <p className="text-[11px] text-slate-500 mt-1 max-w-3xl leading-relaxed">
            `.env` is always bootstrap. An explicit Settings save writes a database overlay and wins on restart.
            Reset to .env removes only that overlay. Secrets stay Configured ✓. PAPER_TRADING_ONLY and LIVE arming cannot be overridden here.
            This panel does not place orders.
          </p>
        </div>
        <button
          type="button"
          onClick={exportJson}
          disabled={!!busy}
          className="shrink-0 px-3 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
        >
          Export effective config
        </button>
      </div>
      {error && <p className="text-[11px] font-mono text-rose-400">{error}</p>}

      {Array.from(grouped.entries()).map(([category, items]) => (
        <div key={category} className="space-y-2">
          <h4 className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-[0.2em]">{category}</h4>
          {items.map((row) => (
            <div key={row.setting} className="border border-slate-800 rounded-md p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs text-slate-200 font-medium">{row.label}</div>
                  <div className="text-[10px] font-mono text-slate-500">{row.setting}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-emerald-400">Effective {formatValue(row, 'effective')}</span>
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400">Source {sourceLabel(row.source)}</span>
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-500">.env {formatValue(row, 'env')}</span>
                </div>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">{row.description}</p>
              {row.restartRequired && !row.secret && (
                <p className="text-[10px] font-mono text-amber-400/90">Restart required to apply.</p>
              )}
              {row.safetyLocked && (
                <p className="text-[10px] font-mono text-rose-400/80">Safety lock — Settings cannot override this.</p>
              )}
              {row.overridable && row.type === 'boolean' && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setOverride(row, true)}
                    className="px-2 py-1 text-[10px] font-mono uppercase rounded bg-emerald-600/20 text-emerald-300 border border-emerald-500/30"
                  >
                    Set ON
                  </button>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setOverride(row, false)}
                    className="px-2 py-1 text-[10px] font-mono uppercase rounded bg-slate-800 text-slate-300 border border-slate-700"
                  >
                    Set OFF
                  </button>
                  <button
                    type="button"
                    disabled={!!busy || row.source !== 'SETTINGS'}
                    onClick={() => resetOne(row)}
                    className="px-2 py-1 text-[10px] font-mono uppercase rounded border border-indigo-500/40 text-indigo-300"
                  >
                    Reset to .env
                  </button>
                </div>
              )}
              {row.overridable && row.type === 'number' && (
                <form
                  className="flex flex-wrap gap-2 items-center"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    setOverride(row, Number(fd.get('n')));
                  }}
                >
                  <input name="n" type="number" min={1} defaultValue={typeof row.effectiveValue === 'number' ? row.effectiveValue : undefined} className="w-32 bg-[#111822] border border-slate-800 rounded p-1.5 text-xs text-slate-200" />
                  <button type="submit" disabled={!!busy} className="px-2 py-1 text-[10px] font-mono uppercase rounded bg-emerald-600/20 text-emerald-300 border border-emerald-500/30">Save</button>
                  <button type="button" disabled={!!busy || row.source !== 'SETTINGS'} onClick={() => resetOne(row)} className="px-2 py-1 text-[10px] font-mono uppercase rounded border border-indigo-500/40 text-indigo-300">Reset to .env</button>
                </form>
              )}
            </div>
          ))}
        </div>
      ))}

      <div className="border border-rose-900/40 rounded-md p-3 space-y-2">
        <h4 className="text-[10px] font-mono font-bold text-rose-300 uppercase tracking-widest">Reset all overlays to .env</h4>
        <p className="text-[11px] text-slate-500">Deletes config_overrides only. Does not touch trades, fills, positions, risk records, audit history, or broker credentials. Type {resetPhrase} to confirm.</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={confirmAll}
            onChange={(e) => setConfirmAll(e.target.value)}
            placeholder={resetPhrase}
            className="flex-1 min-w-[12rem] bg-[#111822] border border-slate-800 rounded p-2 text-xs text-slate-200 font-mono"
          />
          <button
            type="button"
            disabled={!!busy || confirmAll !== resetPhrase}
            onClick={resetAll}
            className="px-3 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest rounded bg-rose-700/80 text-white disabled:opacity-40"
          >
            Reset all to .env
          </button>
        </div>
      </div>
    </div>
  );
}
