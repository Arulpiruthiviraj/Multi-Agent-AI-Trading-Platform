import React, { useMemo, useState } from 'react';
import { Activity, Filter, Terminal } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { patchMobileMissionSnapshot, type MobileLogEvent } from './mobileMissionStore';
import { truncateText } from './mobileUtils';
import { VirtualList } from '../responsive/VirtualList';
import { JsonDetailModal } from './JsonDetailModal';

const FILTER_OPTIONS = ['ALL', 'TRADE', 'RISK', 'ORDER', 'CONSENSUS'] as const;

export function MobileHealthLog() {
  const diagnostics = useMobileMissionSelector((s) => s.diagnostics);
  const startupHealth = useMobileMissionSelector((s) => s.startupHealth);
  const logEvents = useMobileMissionSelector((s) => s.logEvents);
  const logFilter = useMobileMissionSelector((s) => s.logFilter);
  const [jsonOpen, setJsonOpen] = useState<{ title: string; data: unknown } | null>(null);

  const filteredEvents = useMemo(() => {
    const q = logFilter.trim().toUpperCase();
    if (!q || q === 'ALL') return logEvents.slice(0, 50);
    return logEvents.filter((e) => {
      if (FILTER_OPTIONS.includes(q as typeof FILTER_OPTIONS[number])) {
        if (q === 'TRADE') return e.type.includes('TRADE') || e.type.includes('IDEA');
        if (q === 'RISK') return e.type.includes('RISK');
        if (q === 'ORDER') return e.type.includes('ORDER');
        if (q === 'CONSENSUS') return e.type.includes('CONSENSUS') || e.type.includes('CHIEF');
      }
      return e.type.toUpperCase().includes(q) || String(e.source || '').toUpperCase().includes(q);
    }).slice(0, 50);
  }, [logEvents, logFilter]);

  const healthItems = [
    ...startupHealth.map((s: any) => ({
      id: s.id || s.name,
      label: s.name || s.id,
      status: s.status || s.health || 'UNKNOWN',
      detail: s.detail || s.message,
    })),
    ...diagnostics.slice(0, 8).map((d: any) => ({
      id: d.id || d.code,
      label: d.component || d.code,
      status: d.status,
      detail: d.cause || d.message,
    })),
  ];

  return (
    <>
      <section className="rounded-xl border border-slate-800 bg-[#111822] p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={16} className="text-sky-400" />
          <h2 className="text-xs font-mono uppercase tracking-widest text-slate-200">Health grid</h2>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4 max-h-40 overflow-y-auto">
          {healthItems.length === 0 ? (
            <p className="col-span-2 text-[10px] font-mono text-slate-500">Diagnostics not loaded.</p>
          ) : (
            healthItems.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setJsonOpen({ title: h.label, data: h })}
                className="min-h-[44px] text-left rounded border border-slate-800 p-2"
              >
                <p className="text-[9px] font-mono uppercase text-slate-500 truncate">{h.label}</p>
                <p className={`text-[10px] font-bold font-mono ${
                  String(h.status).includes('OK') || h.status === 'READY' || h.status === 'Healthy'
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }`}>
                  {h.status}
                </p>
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-2 mb-2">
          <Terminal size={14} className="text-slate-500" />
          <h3 className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Event log (50)</h3>
        </div>

        <div className="flex gap-1 mb-2 overflow-x-auto pb-1">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => patchMobileMissionSnapshot({ logFilter: f === 'ALL' ? '' : f })}
              className={`shrink-0 min-h-[36px] px-2 rounded text-[9px] font-mono uppercase border ${
                (logFilter || 'ALL') === f || (f === 'ALL' && !logFilter)
                  ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
                  : 'border-slate-800 text-slate-500'
              }`}
            >
              <Filter size={10} className="inline mr-1" />
              {f}
            </button>
          ))}
        </div>

        <VirtualList<MobileLogEvent>
          items={filteredEvents}
          itemHeight={52}
          maxHeight={224}
          className="font-mono text-[10px] bg-slate-950/50 rounded border border-slate-800 p-2"
          renderItem={(e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setJsonOpen({ title: e.type, data: e.payload ?? e })}
              className="w-full text-left min-h-[44px] py-1 border-b border-slate-800/40 last:border-0 hover:bg-slate-900/50 px-1"
            >
              <span className="text-indigo-400">{e.type}</span>
              <span className="text-slate-600 ml-2">{new Date(e.timestamp).toLocaleTimeString()}</span>
              {e.source && <span className="text-slate-500 ml-1">· {e.source}</span>}
              <p className="text-slate-500 truncate">{truncateText(JSON.stringify(e.payload ?? {}), 60)}</p>
            </button>
          )}
        />
        {filteredEvents.length === 0 && (
          <p className="text-slate-600 py-4 text-center text-[10px] font-mono">No events match filter.</p>
        )}
      </section>

      <JsonDetailModal
        open={jsonOpen != null}
        title={jsonOpen?.title || 'Detail'}
        data={jsonOpen?.data}
        onClose={() => setJsonOpen(null)}
      />
    </>
  );
}
