/**
 * ==========================================================
 * Module: TransactionObservatory
 *
 * Purpose:
 * The unified "watch exactly how this decision was produced" view
 * (TRANSACTION_OBSERVATORY_ARCHITECTURE.md, Phase 5). Everything rendered here comes from one
 * real API call - GET /api/v2/transactions/:id, which assembles the transaction, consensus
 * decision, every contributing agent's evidence, the full risk gate ladder, the order lifecycle,
 * fills, and durable events from real tables. No recomputation, no model calls, no fabricated
 * placeholders - a stage that never happened (e.g. a NO_CONSENSUS transaction never reaching
 * risk) is rendered as an explicit "not evaluated" state, never guessed.
 *
 * VCR controls (play/pause/step/speed/scrub) operate over the real, already-persisted stage
 * timestamps - replay never re-runs a model or recalculates a decision.
 * ==========================================================
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  X, Play, Pause, SkipBack, SkipForward, RotateCcw, Activity, Users, Scale, ShieldCheck,
  ShieldAlert, Send, CheckCircle2, XCircle, HelpCircle, ChevronDown, ChevronRight,
} from 'lucide-react';

interface Evidence {
  id: number;
  agent: string;
  side: string;
  confidence: number;
  weight: number;
  reasoning: string | null;
  agreed: boolean;
  currentPrice: number | null;
}

interface RiskGate {
  id: number;
  gateName: string;
  sequence: number;
  passed: boolean;
  detail: any;
}

interface TransactionData {
  transaction: { id: string; symbol: string; openedAt: string; closedAt: string | null; status: string; finalDecision: string | null; outcome: string };
  consensusDecision: { symbol: string; side: string; weightedConfidence: number; threshold: number; approved: boolean; agreementsCount: number; disagreementsCount: number; debateUsed: boolean; reasoning: string | null; createdAt: string } | null;
  evidence: Evidence[];
  riskAssessment: { approved: boolean; maxQuantity: number; rejectionGate: string | null; accountEquity: number | null; buyingPower: number | null; reasoning: string | null; createdAt: string } | null;
  riskGates: RiskGate[];
  order: { id: string; status: string; price: number; quantity: number; brokerOrderId: string | null; requestId: string | null; submittedAt: string | null; acceptedAt: string | null; filledAt: string | null; profitLoss: number | null } | null;
  fills: { id: number; brokerFillId: string | null; quantity: number; price: number; filledAt: string }[];
  events: { id: string; eventType: string; timestamp: number; payload: any }[];
}

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10];
const BASE_STEP_MS = 1600;

const GATE_LABELS: Record<string, string> = {
  emergency_stop: 'Emergency Stop',
  daily_loss: 'Daily Loss',
  consecutive_loss: 'Consecutive Loss',
  market_hours: 'Market Hours',
  data_freshness: 'Data Freshness',
  news_veto: 'News Veto',
  price_validity: 'Price Validity',
  symbol_concentration: 'Symbol Exposure',
  sector_concentration: 'Sector Exposure',
  correlation_exposure: 'Correlation',
  sufficient_size: 'Sufficient Size',
  sell_position_exists: 'Position Exists',
};

function fmtTime(ts: string | number | null | undefined): string {
  if (!ts) return '--';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

interface Stage {
  key: string;
  label: string;
  icon: React.ReactNode;
  timestamp: string | null;
  available: boolean;
}

export default function TransactionObservatory({ transactionId, onClose }: { transactionId: string; onClose: () => void }) {
  const [data, setData] = useState<TransactionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [stageIndex, setStageIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [expandedGate, setExpandedGate] = useState<number | null>(null);
  const [showRawEvents, setShowRawEvents] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v2/transactions/${transactionId}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        if (!json.ok) { setError(json.error || 'Unknown error'); setLoading(false); return; }
        setData(json);
        setLoading(false);
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [transactionId]);

  const stages: Stage[] = useMemo(() => {
    if (!data) return [];
    const all: Stage[] = [
      { key: 'CONSENSUS', label: 'Chief Trader Consensus', icon: <Users size={16} />, timestamp: data.consensusDecision?.createdAt ?? data.transaction.openedAt, available: true },
      { key: 'RISK', label: 'Risk Assessment', icon: <ShieldCheck size={16} />, timestamp: data.riskAssessment?.createdAt ?? null, available: !!data.riskAssessment },
      { key: 'ORDER_SUBMITTED', label: 'Order Submitted', icon: <Send size={16} />, timestamp: data.order?.submittedAt ?? null, available: !!data.order?.submittedAt },
      { key: 'ORDER_ACCEPTED', label: 'Broker Accepted', icon: <CheckCircle2 size={16} />, timestamp: data.order?.acceptedAt ?? null, available: !!data.order?.acceptedAt },
      { key: 'ORDER_FILLED', label: 'Filled', icon: <Scale size={16} />, timestamp: data.order?.filledAt ?? null, available: !!data.order?.filledAt },
    ];
    return all.filter(s => s.available);
  }, [data]);

  useEffect(() => {
    if (!isPlaying || stages.length === 0) return;
    if (stageIndex >= stages.length - 1) { setIsPlaying(false); return; }
    const timer = setTimeout(() => setStageIndex(i => Math.min(i + 1, stages.length - 1)), BASE_STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [isPlaying, stageIndex, stages.length, speed]);

  const stepBack = useCallback(() => { setIsPlaying(false); setStageIndex(i => Math.max(0, i - 1)); }, []);
  const stepForward = useCallback(() => { setIsPlaying(false); setStageIndex(i => Math.min(stages.length - 1, i + 1)); }, [stages.length]);
  const restart = useCallback(() => { setIsPlaying(false); setStageIndex(0); }, []);

  if (loading) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
        <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-8 text-slate-400 text-xs font-mono uppercase tracking-widest">Loading transaction...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
        <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-md shadow-2xl p-6 flex flex-col items-center gap-3 font-mono">
          <XCircle size={28} className="text-rose-400" />
          <p className="text-sm font-bold uppercase tracking-widest text-slate-300">Transaction Not Found</p>
          <p className="text-xs text-slate-500 text-center">{error || `No data for ${transactionId}`}</p>
          <button onClick={onClose} className="mt-2 text-[10px] uppercase tracking-widest text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5">Close</button>
        </div>
      </div>
    );
  }

  const { transaction, consensusDecision, evidence, riskAssessment, riskGates, order, fills, events } = data;
  const currentStage = stages[stageIndex]?.key;
  const stageReached = (key: string) => {
    const idx = stages.findIndex(s => s.key === key);
    return idx !== -1 && idx <= stageIndex;
  };

  const decisionColor = transaction.finalDecision === 'BUY' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
    : transaction.finalDecision === 'SELL' ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
    : 'text-slate-400 bg-slate-800 border-slate-700';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-6xl shadow-2xl overflow-hidden animate-fade-in relative flex flex-col font-mono max-h-[92vh]">
        {/* Header */}
        <div className="bg-[#111822] border-b border-slate-800 p-4 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/20 p-2 rounded text-indigo-400"><Activity size={18} /></div>
            <div>
              <h2 className="text-white font-bold tracking-widest uppercase text-sm">{transaction.id}</h2>
              <p className="text-slate-500 text-[10px]">{transaction.symbol} &middot; Transaction Observatory</p>
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border ${decisionColor}`}>
              {transaction.finalDecision || transaction.status}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border border-slate-700 text-slate-400">
              {transaction.status}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors"><X size={20} /></button>
        </div>

        <div className="p-6 flex flex-col gap-6 overflow-y-auto">
          {/* Pipeline */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3">Pipeline</h3>
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {stages.map((s, i) => (
                <React.Fragment key={s.key}>
                  {i > 0 && <div className={`h-px w-6 shrink-0 ${i <= stageIndex ? 'bg-emerald-500/60' : 'bg-slate-700'}`} />}
                  <button
                    onClick={() => { setIsPlaying(false); setStageIndex(i); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded border shrink-0 transition-colors ${
                      s.key === currentStage ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400' : i < stageIndex ? 'border-slate-700 text-slate-400' : 'border-slate-800 text-slate-600'
                    }`}
                  >
                    {s.icon}
                    <span className="text-[10px] font-bold uppercase tracking-widest whitespace-nowrap">{s.label}</span>
                    <span className="text-[9px] text-slate-500">{fmtTime(s.timestamp)}</span>
                  </button>
                </React.Fragment>
              ))}
              {stages.length === 0 && <span className="text-[10px] text-slate-600 uppercase tracking-widest">No stages reached</span>}
            </div>
          </div>

          {/* VCR controls */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4 flex items-center gap-4 flex-wrap">
            <button onClick={restart} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"><RotateCcw size={14} /></button>
            <button onClick={stepBack} disabled={stageIndex === 0} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors disabled:opacity-30"><SkipBack size={14} /></button>
            <button
              onClick={() => setIsPlaying(p => !p)}
              disabled={stages.length === 0}
              className={`px-5 py-2 flex items-center gap-2 rounded font-bold tracking-widest uppercase text-[10px] transition-colors disabled:opacity-30 ${isPlaying ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'}`}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              {isPlaying ? 'Pause' : 'Play Replay'}
            </button>
            <button onClick={stepForward} disabled={stageIndex >= stages.length - 1} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors disabled:opacity-30"><SkipForward size={14} /></button>
            <input
              type="range" min={0} max={Math.max(0, stages.length - 1)} value={stageIndex}
              onChange={e => { setIsPlaying(false); setStageIndex(parseInt(e.target.value, 10)); }}
              className="flex-1 min-w-[120px] h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-slate-500 uppercase tracking-widest mr-1">Speed</span>
              {SPEEDS.map(s => (
                <button key={s} onClick={() => setSpeed(s)} className={`text-[9px] px-2 py-1 rounded border ${speed === s ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-slate-700 text-slate-500'}`}>{s}x</button>
              ))}
            </div>
          </div>

          {/* Agent Consensus Map */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2"><Users size={13} /> Agent Consensus Map</h3>
            {evidence.length === 0 ? (
              <p className="text-xs text-slate-600 italic">No evidence recorded for this transaction.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {evidence.map(e => (
                  <div key={e.id} className={`flex items-center gap-3 p-2 rounded border ${e.agreed ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                    <span className={`text-[10px] font-bold uppercase tracking-widest w-16 shrink-0 ${e.side === 'BUY' ? 'text-emerald-400' : e.side === 'SELL' ? 'text-amber-400' : 'text-slate-400'}`}>{e.side}</span>
                    <span className="text-xs text-white font-bold shrink-0 w-36 truncate">{e.agent}</span>
                    <div className="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden">
                      <div className={`h-full ${e.side === 'BUY' ? 'bg-emerald-500' : e.side === 'SELL' ? 'bg-amber-500' : 'bg-slate-500'}`} style={{ width: `${Math.round(e.confidence * 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-400 w-12 text-right shrink-0">{Math.round(e.confidence * 100)}%</span>
                    <span className="text-[9px] text-slate-500 w-16 text-right shrink-0">wt {e.weight.toFixed(2)}</span>
                    {e.agreed ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" /> : <XCircle size={13} className="text-rose-500 shrink-0" />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Chief Trader math */}
          {consensusDecision && (
            <div className="bg-[#111822] border border-slate-800 rounded p-4">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2"><Scale size={13} /> Chief Trader Consensus</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                <div><p className="text-[9px] text-slate-500 uppercase tracking-widest">Weighted Confidence</p><p className="text-lg font-bold text-white">{(consensusDecision.weightedConfidence * 100).toFixed(1)}%</p></div>
                <div><p className="text-[9px] text-slate-500 uppercase tracking-widest">Threshold</p><p className="text-lg font-bold text-slate-400">{(consensusDecision.threshold * 100).toFixed(0)}%</p></div>
                <div><p className="text-[9px] text-slate-500 uppercase tracking-widest">Agreed / Disagreed</p><p className="text-lg font-bold text-white">{consensusDecision.agreementsCount} / {consensusDecision.disagreementsCount}</p></div>
                <div><p className="text-[9px] text-slate-500 uppercase tracking-widest">Result</p><p className={`text-lg font-bold ${consensusDecision.approved ? 'text-emerald-400' : 'text-rose-400'}`}>{consensusDecision.approved ? 'APPROVED' : 'NOT APPROVED'}</p></div>
              </div>
              {consensusDecision.reasoning && <p className="text-[11px] text-slate-400 mt-3 border-t border-slate-800 pt-3">{consensusDecision.reasoning}</p>}
            </div>
          )}

          {/* Risk gate ladder */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2"><ShieldCheck size={13} /> Risk Engine</h3>
            {!riskAssessment ? (
              <div className="flex items-center gap-2 text-slate-600 italic text-xs">
                <HelpCircle size={14} /> Not yet evaluated - this transaction never reached RiskEngine.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  {riskGates.map(g => {
                    const skipped = g.detail?.skipped;
                    return (
                      <div key={g.id}>
                        <button
                          onClick={() => setExpandedGate(expandedGate === g.id ? null : g.id)}
                          className={`w-full flex items-center gap-2 p-2 rounded border text-left transition-colors ${
                            skipped ? 'border-slate-800 text-slate-500' : g.passed ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400' : 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                          }`}
                        >
                          {expandedGate === g.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          {skipped ? <HelpCircle size={14} className="shrink-0" /> : g.passed ? <CheckCircle2 size={14} className="shrink-0" /> : <XCircle size={14} className="shrink-0" />}
                          <span className="text-[11px] font-bold uppercase tracking-widest flex-1">{GATE_LABELS[g.gateName] || g.gateName}</span>
                          <span className="text-[9px] uppercase tracking-widest">{skipped ? 'N/A' : g.passed ? 'PASS' : 'FAIL'}</span>
                        </button>
                        {expandedGate === g.id && (
                          <pre className="text-[10px] text-slate-400 bg-black/30 rounded p-2 mt-1 overflow-x-auto">{JSON.stringify(g.detail, null, 2)}</pre>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className={`mt-3 pt-3 border-t border-slate-800 text-xs ${riskAssessment.approved ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {riskAssessment.approved ? `Approved - max ${riskAssessment.maxQuantity} shares` : `Rejected at: ${GATE_LABELS[riskAssessment.rejectionGate || ''] || riskAssessment.rejectionGate}`}
                  <span className="text-slate-500 ml-2">{riskAssessment.reasoning}</span>
                </div>
              </>
            )}
          </div>

          {/* Order lifecycle */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2"><Send size={13} /> Order Lifecycle</h3>
            {!order ? (
              <div className="flex items-center gap-2 text-slate-600 italic text-xs">
                <HelpCircle size={14} /> No order was placed for this transaction.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center text-[10px]">
                  <div><p className="text-slate-500 uppercase tracking-widest">Submitted</p><p className="text-white">{fmtTime(order.submittedAt)}</p></div>
                  <div><p className="text-slate-500 uppercase tracking-widest">Accepted</p><p className="text-white">{fmtTime(order.acceptedAt)}</p></div>
                  <div><p className="text-slate-500 uppercase tracking-widest">Filled</p><p className="text-white">{fmtTime(order.filledAt)}</p></div>
                  <div><p className="text-slate-500 uppercase tracking-widest">Status</p><p className={order.status === 'FILLED' ? 'text-emerald-400' : order.status === 'REJECTED' ? 'text-rose-400' : 'text-amber-400'}>{order.status}</p></div>
                  <div><p className="text-slate-500 uppercase tracking-widest">Broker Order ID</p><p className="text-white truncate">{order.brokerOrderId || '--'}</p></div>
                </div>
                {fills.length > 0 && (
                  <div className="border-t border-slate-800 pt-3">
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Fills</p>
                    {fills.map(f => (
                      <div key={f.id} className="text-[11px] text-slate-300">{f.quantity} @ ${f.price.toFixed(2)} &middot; {fmtTime(f.filledAt)}</div>
                    ))}
                  </div>
                )}
                {order.profitLoss !== null && order.profitLoss !== undefined && (
                  <div className={`text-xs font-bold ${order.profitLoss >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    Realized P&L: {order.profitLoss >= 0 ? '+' : ''}{order.profitLoss.toFixed(2)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Raw events */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <button onClick={() => setShowRawEvents(v => !v)} className="w-full flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-slate-500">
              <span>Raw Events ({events.length})</span>
              {showRawEvents ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {showRawEvents && (
              <div className="mt-3 flex flex-col gap-2 max-h-64 overflow-y-auto">
                {events.map(e => (
                  <div key={e.id} className="text-[10px] border-l-2 border-slate-700 pl-2">
                    <span className="text-slate-400 font-bold">{e.eventType}</span>
                    <span className="text-slate-600 ml-2">{fmtTime(e.timestamp)}</span>
                    <pre className="text-slate-500 overflow-x-auto">{JSON.stringify(e.payload, null, 2)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
