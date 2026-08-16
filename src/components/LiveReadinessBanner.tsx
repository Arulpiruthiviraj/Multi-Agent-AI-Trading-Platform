/* === COMPONENT: LiveReadinessBanner === */
import React, { useEffect, useState } from 'react';

interface LiveReadinessPayload {
  result?: string;
  tradingEdgeScore?: number;
  organicPaper?: string;
  canadianLive?: string;
  failedMandatory?: string[];
}

export default function LiveReadinessBanner() {
  const [data, setData] = useState<LiveReadinessPayload | null>(null);

  useEffect(() => {
    const load = () => {
      fetch('/api/v2/live-readiness')
        .then((r) => r.json())
        .then((j) => setData(j))
        .catch(() => setData(null));
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const result = data?.result || 'LIVE_NO_GO';
  const isGo = result === 'LIVE_READY';

  return (
    <div className={'border rounded-lg p-4 ' + (isGo ? 'bg-emerald-500/5 border-emerald-500/30' : 'bg-rose-500/5 border-rose-500/40')}>
      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-1">Live readiness</div>
      <div className={'text-sm font-bold font-mono tracking-widest ' + (isGo ? 'text-emerald-400' : 'text-rose-400')}>
        {result}
      </div>
      <p className="text-[10px] text-slate-400 mt-2 leading-relaxed font-mono">
        Edge score {data?.tradingEdgeScore ?? '—'}. Organic paper {data?.organicPaper ?? 'NOT_ESTABLISHED'}.
        Canadian live {data?.canadianLive ?? 'NOT_AVAILABLE'}.
        {data?.failedMandatory && data.failedMandatory.length > 0
          ? ` Mandatory fails: ${data.failedMandatory.slice(0, 6).join(', ')}${data.failedMandatory.length > 6 ? '…' : ''}.`
          : ''}
      </p>
    </div>
  );
}
