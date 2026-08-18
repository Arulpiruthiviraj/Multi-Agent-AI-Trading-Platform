import React from 'react';
import { useMobileMissionSelector } from '../useMobileMissionSelector';
import { MobileConsensusCard } from '../MobileConsensusCard';
import { MobileQuantInspector } from '../MobileQuantInspector';
import { MobileGlassCard } from '../MobileGlassCard';
import { fmtPct } from '../mobileUtils';

const PIPELINE_STEPS = [
  'Market Data',
  'Agents',
  'Chief Consensus',
  'Risk Gates',
  'Paper Fill',
] as const;

export function MobileAiBrainView() {
  const consensus = useMobileMissionSelector((s) => s.consensus);
  const latestTxDetail = useMobileMissionSelector((s) => s.latestTxDetail);
  const agentVotes = consensus.agentVotes;

  const confPct = consensus.weightedConfidence != null ? fmtPct(consensus.weightedConfidence, 0) : '--';
  const side = consensus.side ?? 'HOLD';
  const approved = consensus.approved === true;
  const stepIndex = latestTxDetail?.order ? 4 : latestTxDetail?.riskAssessment ? 3 : agentVotes.length ? 2 : 1;

  return (
    <div className="space-y-4 p-3">
      <MobileGlassCard glow="cyan" active className="mobile-processing-glow">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-mono uppercase tracking-wider text-cyan-400">Chief trader</p>
          <span className={`text-[9px] font-mono uppercase px-2 py-0.5 rounded border ${
            approved ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-amber-500/40 text-amber-300'
          }`}>
            {consensus.noConsensus ? 'NO_CONSENSUS' : approved ? 'CHIEF_APPROVED' : 'PENDING'}
          </span>
        </div>
        <p className="text-2xl font-bold mobile-tabular text-white">
          {confPct} <span className="text-lg text-emerald-400">{side}</span>
        </p>
      </MobileGlassCard>

      <div className="flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory -mx-1 px-1">
        {agentVotes.length === 0 ? (
          <MobileGlassCard className="min-w-[240px] snap-center shrink-0">
            <p className="text-[10px] font-mono text-slate-500">No agent votes on latest transaction.</p>
          </MobileGlassCard>
        ) : (
          agentVotes.map((v) => (
            <div key={v.agent} className="min-w-[220px] snap-center shrink-0">
              <MobileGlassCard className="h-full" glow={v.agreed !== false ? 'emerald' : 'none'}>
                <p className="text-[9px] font-mono uppercase text-cyan-400/80">{v.agent}</p>
                <p className="text-sm font-bold mobile-tabular text-white mt-1">{v.side} {(v.confidence * 100).toFixed(0)}%</p>
                <p className="text-[9px] font-mono text-slate-500 mt-1">weight {v.weight.toFixed(2)}</p>
              </MobileGlassCard>
            </div>
          ))
        )}
      </div>

      <MobileGlassCard>
        <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-3">Decision pipeline</p>
        <div className="flex items-center justify-between gap-1">
          {PIPELINE_STEPS.map((step, i) => (
            <React.Fragment key={step}>
              <div className={`flex-1 text-center min-w-0 ${i <= stepIndex ? 'text-cyan-400' : 'text-slate-600'}`}>
                <div className={`w-2 h-2 rounded-full mx-auto mb-1 ${i <= stepIndex ? 'bg-cyan-400' : 'bg-slate-700'}`} />
                <p className="text-[7px] font-mono uppercase leading-tight truncate">{step}</p>
              </div>
              {i < PIPELINE_STEPS.length - 1 && <div className={`h-px flex-1 max-w-[8px] ${i < stepIndex ? 'bg-cyan-500/50' : 'bg-slate-800'}`} />}
            </React.Fragment>
          ))}
        </div>
      </MobileGlassCard>

      <MobileConsensusCard />
      <MobileQuantInspector />
    </div>
  );
}
