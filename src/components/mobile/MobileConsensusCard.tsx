import React, { useState } from 'react';
import { ChevronDown, Users } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { fmtPct } from './mobileUtils';
import { JsonDetailModal } from './JsonDetailModal';

export function MobileConsensusCard() {
  const consensus = useMobileMissionSelector((s) => s.consensus);
  const latestTxId = useMobileMissionSelector((s) => s.latestTxId);
  const [open, setOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);

  const confPct = consensus.weightedConfidence != null ? fmtPct(consensus.weightedConfidence, 1) : '--';
  const threshPct = consensus.threshold != null ? fmtPct(consensus.threshold, 0) : '--';

  return (
    <>
      <section className="rounded-xl border border-slate-800 bg-[#111822] p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-indigo-400" />
            <h2 className="text-xs font-mono uppercase tracking-widest text-slate-200">Consensus</h2>
          </div>
          {consensus.noConsensus && (
            <span className="text-[9px] font-mono uppercase px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
              NO_CONSENSUS
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3 text-center">
          <div className="rounded border border-slate-800 p-2">
            <p className="text-[9px] font-mono text-slate-500 uppercase">Side</p>
            <p className="text-sm font-bold font-mono text-white">{consensus.side ?? '--'}</p>
          </div>
          <div className="rounded border border-slate-800 p-2">
            <p className="text-[9px] font-mono text-slate-500 uppercase">Confidence</p>
            <p className="text-sm font-bold font-mono text-emerald-400">{confPct}</p>
          </div>
          <div className="rounded border border-slate-800 p-2">
            <p className="text-[9px] font-mono text-slate-500 uppercase">Threshold</p>
            <p className="text-sm font-bold font-mono text-slate-300">{threshPct}</p>
          </div>
        </div>

        {latestTxId && (
          <p className="text-[9px] font-mono text-slate-600 mb-2 truncate">Tx: {latestTxId}</p>
        )}

        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full min-h-[44px] flex items-center justify-between px-3 rounded-lg border border-slate-800 text-[10px] font-mono uppercase tracking-wider text-slate-400"
        >
          Agent breakdown ({consensus.agentVotes.length})
          <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
            {consensus.agentVotes.length === 0 ? (
              <p className="text-[10px] font-mono text-slate-500 py-2">No consensus evidence on latest transaction.</p>
            ) : (
              consensus.agentVotes.map((v) => (
                <div key={v.agent} className="flex items-center justify-between py-1.5 border-b border-slate-800/60 text-[11px] font-mono">
                  <span className="text-slate-300">{v.agent}</span>
                  <span className={v.agreed === false ? 'text-rose-400' : 'text-emerald-400'}>
                    {v.side} {(v.confidence * 100).toFixed(0)}% · w{v.weight.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setJsonOpen(true)}
          className="mt-3 text-[10px] font-mono text-indigo-400 underline min-h-[44px]"
        >
          View full consensus JSON
        </button>
      </section>

      <JsonDetailModal
        open={jsonOpen}
        title="Consensus detail"
        data={consensus}
        onClose={() => setJsonOpen(false)}
      />
    </>
  );
}
