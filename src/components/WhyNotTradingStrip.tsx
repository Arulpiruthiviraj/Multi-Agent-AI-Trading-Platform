import React, { useEffect, useState } from 'react';
import ExplainCard from './ExplainCard';
import TradingPauseOperatorControls from './TradingPauseOperatorControls';

/** Compact command-center strip: live why-not-trading from GET /api/v2/diagnostics/why-not-trading */
export default function WhyNotTradingStrip() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    const load = () => {
      fetch('/api/v2/diagnostics/why-not-trading')
        .then(r => r.json())
        .then(j => { if (j.ok) setData(j); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);
  if (!data) return null;
  return (
    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2">Why is Argus not trading?</div>
      <div className="text-xs text-white font-bold mb-2">
        {data.isTrading ? 'No blocking diagnostic — Autobot enabled and RiskEngine is in TRADING_ENABLED.' : 'New entries are not flowing (Autobot off, a blocking gate, or a feed/config issue).'}
      </div>
      {data.primary && <ExplainCard d={data.primary} compact />}
      {data.primary?.code === 'SYS-001' && (
        <div className="mt-3">
          <TradingPauseOperatorControls />
        </div>
      )}
    </div>
  );
}
