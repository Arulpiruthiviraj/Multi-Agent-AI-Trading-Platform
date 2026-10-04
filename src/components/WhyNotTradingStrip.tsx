import { useState } from 'react';
import ExplainCard from './ExplainCard';
import TradingPauseOperatorControls from './TradingPauseOperatorControls';
import { useApi } from '../hooks/useApi';

type WhyNotTradingPayload = {
  ok?: boolean;
  isTrading?: boolean;
  explanation?: string;
  primary?: {
    code?: string;
    [key: string]: unknown;
  };
};

/** Compact command-center strip: live why-not-trading from GET /api/v2/diagnostics/why-not-trading */
export default function WhyNotTradingStrip() {
  // Last body with ok:true — preserved across polls so a transient bad payload
  // doesn't blank the strip (matches the pre-useApi behavior of only
  // overwriting state when j.ok).
  const [lastGood, setLastGood] = useState<WhyNotTradingPayload | null>(null);
  const { data } = useApi<WhyNotTradingPayload>('/api/v2/diagnostics/why-not-trading', {
    pollIntervalMs: 15_000,
    onSuccess: (d) => {
      if (d?.ok) setLastGood(d);
    },
  });
  const view = lastGood ?? (data?.ok ? data : null);
  if (!view) return null;
  return (
    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2">Why is Argus not trading?</div>
      <div className="text-xs text-white font-bold mb-2">
        {view.isTrading ? 'No blocking diagnostic — Autobot enabled and RiskEngine is in TRADING_ENABLED.' : 'New entries are not flowing (Autobot off, a blocking gate, or a feed/config issue).'}
      </div>
      {view.explanation && (
        <pre className="text-[10px] font-mono text-slate-300 whitespace-pre-wrap bg-[#0d1117] border border-slate-800 rounded p-2 mb-2">{view.explanation}</pre>
      )}
      {view.primary && <ExplainCard d={view.primary} compact />}
      {view.primary?.code === 'SYS-001' && (
        <div className="mt-3">
          <TradingPauseOperatorControls />
        </div>
      )}
    </div>
  );
}
