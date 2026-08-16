/**
 * ==========================================================
 * COMPONENT: AgentFocusMode
 *
 * Deep-dive overlay for Agent Network nodes. Expansion is visual only (≤300ms).
 * Sparklines, gate colors, vote bars, and JSON panels update only from EventBus
 * WebSocket payloads. No Math.random, no fake loading bars, no typewriter of
 * invented tokens (Ollama does not stream on EventBus).
 * ==========================================================
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ShieldCheck, Terminal } from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext';
import eventCatalog from '../../config/eventNames.json';
import agentWeights from '../../config/agentWeights.json';
import riskGateOrder from '../../config/riskGateOrder.json';
import {
  CONSENSUS_APPROVAL_THRESHOLD,
  DISAGREEMENT_PENALTY,
  displayVoteTerms,
  resolveDisplayWeight,
} from './agentFocus/displayConsensus';
import {
  bollingerWidthPct,
  finiteNum,
  isTechnicalEngineCalc,
  unwrapTechPayload,
} from './agentFocus/parseTechTelemetry';

const FOCUS_MS = 0.28;
const SERIES_CAP = 48;
const IDEA_CAP = 24;

type BusEvent = { type: string; timestamp: string; payload: any };

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return <div className="flex h-12 items-center font-mono text-[9px] text-slate-600">Awaiting samples</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 280;
  const h = 48;
  const d = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 6) - 3;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function fmtTs(iso: string | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

function num(v: unknown): number | null {
  return finiteNum(v);
}

function techPayload(evt: BusEvent | undefined) {
  if (!evt) return null;
  return unwrapTechPayload(evt.payload);
}

/* Reveal completed EventBus JSON in ≤FOCUS_MS. Characters come only from the payload; EventBus does not stream Ollama tokens. */
function CompletedJsonReveal({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (!text) {
      setShown('');
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / (FOCUS_MS * 1000));
      setShown(text.slice(0, Math.max(1, Math.ceil(text.length * t))));
      if (t < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [text]);
  return (
    <pre className="max-h-56 overflow-auto font-mono text-[10px] leading-relaxed text-cyan-100 custom-scrollbar">
      {shown}
    </pre>
  );
}

/* === COMPONENT: TechnicalInternals === */
function TechnicalInternals({ events }: { events: BusEvent[] }) {
  const completed = events.filter((e) => {
    if (e.type === 'TECHNICAL_ANALYSIS_COMPLETED') return true;
    return e.type === 'CALCULATION_COMPLETED' && isTechnicalEngineCalc(e.payload);
  });
  const ideas = events.filter((e) => e.type === 'TRADE_IDEA_GENERATED' && e.payload?.agent === 'TechnicalAgent');
  const ticks = events.filter((e) => e.type === 'MARKET_DATA').slice(0, SERIES_CAP).reverse();
  const latestIdea = ideas[0];
  const series = completed.slice(0, SERIES_CAP).reverse();
  const rsi = series.map((e) => num(techPayload(e)?.rsi)).filter((v): v is number => v != null);
  const macd = series.map((e) => num(techPayload(e)?.macd)).filter((v): v is number => v != null);
  const bbw = series.map((e) => bollingerWidthPct(techPayload(e))).filter((v): v is number => v != null);
  const prices = ticks.map((e) => num(e.payload?.price)).filter((v): v is number => v != null);
  const last = techPayload(completed[0]);
  const lastTick = ticks[ticks.length - 1];
  const lastConf = num(latestIdea?.payload?.confidence);

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">
        MARKET_DATA ticks (price) + TECHNICAL_ANALYSIS_COMPLETED / CALCULATION_COMPLETED — RSI / MACD / BB width from payload fields
      </p>
      <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
        <div className="mb-1 flex justify-between font-mono text-[9px] text-slate-500">
          <span>LAST TICK {lastTick?.payload?.symbol || ''}</span>
          <span className="text-sky-300">{lastTick?.payload?.price != null ? Number(lastTick.payload.price).toFixed(2) : '—'}</span>
        </div>
        <Sparkline values={prices} color="#38bdf8" />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
          <div className="mb-1 flex justify-between font-mono text-[9px] text-slate-500">
            <span>RSI14</span>
            <span className="text-amber-300">{last?.rsi != null ? Number(last.rsi).toFixed(2) : '—'}</span>
          </div>
          <Sparkline values={rsi} color="#fbbf24" />
        </div>
        <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
          <div className="mb-1 flex justify-between font-mono text-[9px] text-slate-500">
            <span>MACD</span>
            <span className="text-cyan-300">{last?.macd != null ? Number(last.macd).toFixed(4) : '—'}</span>
          </div>
          <Sparkline values={macd} color="#22d3ee" />
        </div>
        <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
          <div className="mb-1 flex justify-between font-mono text-[9px] text-slate-500">
            <span>BB WIDTH %</span>
            <span className="text-violet-300">{bollingerWidthPct(last) != null ? bollingerWidthPct(last)!.toFixed(3) : '—'}</span>
          </div>
          <Sparkline values={bbw} color="#a78bfa" />
        </div>
      </div>
      <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
        <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">strengthToConfidence</div>
        {lastConf != null ? (
          <motion.div
            key={`${latestIdea?.payload?.traceId}-${lastConf}`}
            initial={{ opacity: 0.35, scale: 1.08 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: FOCUS_MS }}
            className="mt-1 font-mono text-3xl font-bold text-emerald-400"
          >
            {(lastConf * 100).toFixed(1)}%
            <span className="ml-2 text-[10px] font-normal text-slate-500">
              {latestIdea?.payload?.side} {latestIdea?.payload?.symbol} @ {fmtTs(latestIdea?.timestamp)}
            </span>
          </motion.div>
        ) : (
          <div className="mt-1 font-mono text-[11px] text-slate-600">No TechnicalAgent TRADE_IDEA_GENERATED this session — confidence is only computed when a strategy fires.</div>
        )}
        {latestIdea?.payload?.reasoning && (
          <div className="mt-2 font-mono text-[10px] text-slate-300">{latestIdea.payload.reasoning}</div>
        )}
      </div>
    </div>
  );
}

/* === COMPONENT: NewsInternals === */
function NewsInternals({ events, nodeId }: { events: BusEvent[]; nodeId: string }) {
  const started = events.find((e) => e.type === 'NEWS_ANALYSIS_STARTED');
  const analyzed = events.find((e) => e.type === 'NEWS_ANALYZED');
  const escalation = events.find((e) => e.type === 'ESCALATION_DECISION');
  const idea = events.find((e) => e.type === 'TRADE_IDEA_GENERATED' && e.payload?.agent === 'NewsAgent');
  const aiMetrics = events.find((e) => e.type === 'AI_METRICS_UPDATE');
  const impact = analyzed?.payload?.impact;
  const finbertScore = num(impact?.sentiment);
  const source = impact?.sentimentSource;
  const headline = started?.payload?.headline || analyzed?.payload?.aiAnalysis?.headline || idea?.payload?.newsDetails?.sources;
  const jsonObj = analyzed?.payload?.aiAnalysis ?? idea?.payload?.newsDetails ?? null;
  const jsonText = jsonObj ? JSON.stringify(jsonObj, null, 2) : '';
  const provider = idea?.payload?.provider || analyzed?.payload?.aiAnalysis?._provider || aiMetrics?.payload?.provider;
  const local = aiMetrics?.payload?.local === true || (typeof provider === 'string' && /ollama|llama/i.test(provider));

  const steps = [
    { id: 'headline', label: 'HEADLINE', on: Boolean(started || headline) },
    { id: 'finbert', label: 'FINBERT', on: finbertScore != null },
    { id: 'escalation', label: 'ESCALATION', on: Boolean(escalation) },
    { id: 'llm', label: 'LLM JSON', on: Boolean(jsonText) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">
        NEWS_ANALYSIS_STARTED → FinBERT (NEWS_ANALYZED.impact) → optional AIRouter JSON. EventBus has no Ollama token stream.
      </p>
      <div className="grid grid-cols-4 gap-1">
        {steps.map((s) => (
          <div
            key={s.id}
            className={`rounded border px-2 py-1.5 text-center font-mono text-[8px] uppercase tracking-widest ${
              s.on ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300' : 'border-slate-800 text-slate-600'
            }`}
          >
            {s.label}
          </div>
        ))}
      </div>
      <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
        <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Headline</div>
        <div className="mt-1 font-mono text-[12px] text-slate-100">{headline || 'Awaiting NEWS_ANALYSIS_STARTED'}</div>
        <div className="mt-1 font-mono text-[9px] text-slate-500">{fmtTs(started?.timestamp || analyzed?.timestamp)}</div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">FinBERT score</div>
          <div className="mt-1 font-mono text-2xl text-emerald-300">{finbertScore != null ? finbertScore.toFixed(4) : '—'}</div>
          <div className="font-mono text-[9px] text-slate-500">{source || (analyzed ? 'sentimentSource absent' : 'no NEWS_ANALYZED')}</div>
        </div>
        <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Escalation</div>
          <div className="mt-1 font-mono text-[11px] text-amber-300">
            {escalation ? (escalation.payload.escalated ? 'ESCALATED → LLM' : 'LOCAL-FIRST SKIP') : '—'}
          </div>
          <div className="mt-1 font-mono text-[9px] text-slate-500">{escalation?.payload?.reason || ''}</div>
        </div>
        <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{nodeId === 'paid-llm-pool' ? 'Paid pool' : 'Local / Ollama'}</div>
          <div className="mt-1 font-mono text-[11px] text-cyan-300">{provider || (local ? 'local (AI_METRICS_UPDATE)' : '—')}</div>
          <div className="font-mono text-[9px] text-slate-500">
            {aiMetrics?.payload?.latency != null ? `${aiMetrics.payload.latency}ms` : idea?.payload?.latencyMs != null ? `${idea.payload.latencyMs}ms` : 'no latency field'}
          </div>
        </div>
      </div>
      <div className="rounded border border-cyan-900/40 bg-[#05080d] p-3">
        <div className="mb-2 flex justify-between text-[9px] font-bold uppercase tracking-widest text-cyan-400/80">
          <span>Completed reasoning JSON</span>
          <span className="font-mono font-normal text-slate-500">not a simulated typewriter</span>
        </div>
        {jsonText ? (
          <CompletedJsonReveal text={jsonText} />
        ) : (
          <div className="font-mono text-[11px] text-slate-600">
            {escalation?.payload?.escalated
              ? 'LLM call in flight — waiting for NEWS_ANALYZED.aiAnalysis'
              : 'Awaiting NEWS_ANALYZED / NewsAgent idea payload'}
          </div>
        )}
      </div>
    </div>
  );
}

/* === COMPONENT: ChiefInternals === */
function ChiefInternals({
  events,
  weights,
}: {
  events: BusEvent[];
  weights: { agentName: string; currentWeight: number | null }[];
}) {
  const started = events.find((e) => e.type === 'CHIEF_CONSENSUS_STARTED');
  const completed = events.find((e) => e.type === 'CHIEF_CONSENSUS_COMPLETED');
  const approved = events.find((e) => e.type === 'CHIEF_APPROVED_IDEA');
  const focusSymbol = started?.payload?.symbol || completed?.payload?.symbol || approved?.payload?.symbol;
  const ideas = events
    .filter((e) => e.type === 'TRADE_IDEA_GENERATED')
    .filter((e) => !focusSymbol || e.payload?.symbol === focusSymbol)
    .slice(0, IDEA_CAP);

  const votes = ideas.map((e) => ({
    agent: String(e.payload?.agent || 'unknown'),
    side: e.payload?.side as 'BUY' | 'SELL' | 'HOLD',
    confidence: num(e.payload?.confidence) ?? 0,
    weight: resolveDisplayWeight(String(e.payload?.agent || ''), weights),
    reasoning: String(e.payload?.reasoning || ''),
    ts: e.timestamp,
  }));

  let liveNet: number | null = null;
  let liveTerms: { weightedSum: number; totalWeight: number; net: number } | null = null;
  let liveSide: 'BUY' | 'SELL' | null = null;
  if (votes.length) {
    const buy = votes.filter((v) => v.side === 'BUY');
    const sell = votes.filter((v) => v.side === 'SELL');
    const hold = votes.filter((v) => v.side === 'HOLD' && v.confidence > 0);
    const buyTerms = displayVoteTerms(buy, [...sell, ...hold]);
    const sellTerms = displayVoteTerms(sell, [...buy, ...hold]);
    liveNet = Math.max(buyTerms.net, sellTerms.net);
    liveTerms = buyTerms.net >= sellTerms.net ? buyTerms : sellTerms;
    liveSide = buyTerms.net >= sellTerms.net ? 'BUY' : 'SELL';
  }

  const official = num(completed?.payload?.confidence);
  const threshold = num(completed?.payload?.threshold) ?? CONSENSUS_APPROVAL_THRESHOLD;
  const meter = official ?? liveNet;
  const pct = meter != null ? meter / threshold : 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">
        TRADE_IDEA_GENERATED stack × live weights. Official fraction is CHIEF_CONSENSUS_COMPLETED.confidence vs threshold from payload / tradingSafety.
      </p>
      <div className="rounded border border-slate-800 bg-[#0A0F16] p-3">
        <div className="mb-2 flex justify-between font-mono text-[10px] text-slate-400">
          <span>{focusSymbol || 'no symbol yet'}</span>
          <span>
            {official != null ? `official ${(official * 100).toFixed(1)}%` : liveNet != null ? `live stack ${(liveNet * 100).toFixed(1)}%` : '—'}
            {' / '}
            {(threshold * 100).toFixed(0)}% bar
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-800">
          <motion.div
            className={`h-full ${meter != null && meter >= threshold ? 'bg-emerald-400' : 'bg-amber-400'}`}
            initial={false}
            animate={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }}
            transition={{ duration: FOCUS_MS }}
          />
        </div>
        <div className="mt-2 font-mono text-[9px] leading-relaxed text-slate-400">
          EvidenceAggregator: (Σ c·w − {DISAGREEMENT_PENALTY}·Σ c_opp·w) / Σ w
          {liveTerms ? (
            <span className="ml-2 text-cyan-300">
              live {liveSide} {liveTerms.weightedSum.toFixed(4)} / {liveTerms.totalWeight.toFixed(4)} = {liveTerms.net.toFixed(4)} vs {threshold.toFixed(2)}
            </span>
          ) : (
            <span className="ml-2">awaiting votes</span>
          )}
        </div>
        {approved && (
          <div className="mt-2 rounded border border-fuchsia-800/50 bg-fuchsia-950/20 px-2 py-1.5 font-mono text-[10px] text-fuchsia-200">
            CHIEF_APPROVED_IDEA {approved.payload?.side} {approved.payload?.symbol} conf=
            {num(approved.payload?.confidence) != null ? (num(approved.payload.confidence)! * 100).toFixed(1) : '—'}%
            {' · '}
            {fmtTs(approved.timestamp)}
          </div>
        )}
      </div>
      <div className="flex max-h-64 flex-col gap-2 overflow-y-auto custom-scrollbar">
        {votes.length === 0 && (
          <div className="font-mono text-[11px] text-slate-600">Awaiting TRADE_IDEA_GENERATED</div>
        )}
        {[...votes].reverse().map((v, i) => (
          <motion.div
            key={`${v.agent}-${v.ts}-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: FOCUS_MS }}
            className="flex items-center justify-between rounded border border-slate-800 bg-[#05080d] px-3 py-2 font-mono text-[10px]"
          >
            <span className="text-slate-300">{v.agent}</span>
            <span className={v.side === 'BUY' ? 'text-emerald-400' : v.side === 'SELL' ? 'text-rose-400' : 'text-slate-400'}>{v.side}</span>
            <span className="text-cyan-300">c={(v.confidence * 100).toFixed(1)}%</span>
            <span className="text-slate-500">wt={v.weight.toFixed(2)}</span>
            <span className="text-amber-200">{(v.confidence * v.weight).toFixed(3)}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/* === COMPONENT: RiskInternals === */
function RiskInternals({ events }: { events: BusEvent[] }) {
  const started = events.find((e) => e.type === 'RISK_ASSESSMENT_STARTED');
  const completed = events.find((e) => e.type === 'RISK_ASSESSMENT_COMPLETED');
  const traceId = started?.payload?.traceId || completed?.payload?.traceId;
  const txId = started?.payload?.transactionId || completed?.payload?.transactionId;
  const [persisted, setPersisted] = useState<Array<{ gate: string; passed: boolean; sequence: number; detail: any }>>([]);

  useEffect(() => {
    if (!txId || !completed) {
      setPersisted([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/v2/transactions/${encodeURIComponent(String(txId))}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled || !body?.ok || !Array.isArray(body.riskGates)) return;
        setPersisted(body.riskGates.map((g: any) => ({
          gate: String(g.gate || ''),
          passed: g.passed === true,
          sequence: typeof g.sequence === 'number' ? g.sequence : 0,
          detail: g.detail,
        })).filter((g: { gate: string }) => g.gate));
      })
      .catch(() => { /* live RISK_GATE_EVALUATED remains the primary source */ });
    return () => { cancelled = true; };
  }, [txId, completed]);
  const gatesForRun = events.filter((e) => {
    if (e.type !== 'RISK_GATE_EVALUATED') return false;
    if (!traceId) return true;
    return e.payload?.traceId === traceId;
  });
  const byName = new Map<string, { passed: boolean; sequence: number; detail: any; ts: string }>();
  for (const g of [...gatesForRun].reverse()) {
    const name = String(g.payload?.gate || '');
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      passed: g.payload?.passed === true,
      sequence: typeof g.payload?.sequence === 'number' ? g.payload.sequence : 0,
      detail: g.payload?.detail,
      ts: g.timestamp,
    });
  }
  for (const g of persisted) {
    if (!g.gate || byName.has(g.gate)) continue;
    byName.set(g.gate, { passed: g.passed, sequence: g.sequence, detail: g.detail, ts: completed?.timestamp || '' });
  }
  const extra = [...byName.keys()].filter((k) => !riskGateOrder.gates.includes(k));
  const ladder = [...riskGateOrder.gates, ...extra];
  const rejection = completed?.payload?.rejectionGate || completed?.payload?.gate;
  const firstFail = completed?.payload?.approved === false
    ? (typeof rejection === 'string' ? rejection : ladder.find((n) => byName.get(n)?.passed === false))
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">
        {riskGateOrder.gates.length} gates from config/riskGateOrder.json. Live colors = RISK_GATE_EVALUATED; gaps filled from risk_gate_results via GET /api/v2/transactions/:id after COMPLETED.
      </p>
      <div className="flex justify-between font-mono text-[10px] text-slate-400">
        <span>{started ? `${started.payload?.side} ${started.payload?.symbol}` : 'Awaiting RISK_ASSESSMENT_STARTED'}</span>
        <span>
          {completed
            ? completed.payload?.approved ? 'APPROVED' : `REJECTED${firstFail ? ` @ ${firstFail}` : ''}`
            : started ? 'EVALUATING' : 'IDLE'}
        </span>
      </div>
      <div className="grid max-h-80 grid-cols-1 gap-1 overflow-y-auto custom-scrollbar md:grid-cols-2">
        {ladder.map((name, idx) => {
          const hit = byName.get(name);
          const lockedFail = firstFail === name;
          const cls = !hit
            ? 'border-slate-800 text-slate-600'
            : lockedFail || hit.passed === false
              ? 'border-rose-500/60 bg-rose-950/40 text-rose-300'
              : 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300';
          return (
            <motion.div
              key={name}
              initial={false}
              animate={{ opacity: hit || started ? 1 : 0.45 }}
              transition={{ duration: FOCUS_MS, delay: hit ? Math.min(idx * 0.012, 0.2) : 0 }}
              className={`flex items-center justify-between rounded border px-2 py-1.5 font-mono text-[10px] ${cls}`}
            >
              <span className="flex items-center gap-2">
                <span className="w-5 text-slate-500">{String(hit?.sequence ?? idx).padStart(2, '0')}</span>
                {name}
              </span>
              <span>
                {!hit ? (started ? '…' : '—') : hit.passed ? 'PASS' : 'FAIL'}
              </span>
            </motion.div>
          );
        })}
      </div>
      {completed?.payload?.reasoning && (
        <div className="font-mono text-[10px] text-slate-400">{completed.payload.reasoning}</div>
      )}
    </div>
  );
}

function GenericInternals({ events }: { events: BusEvent[] }) {
  const latest = events[0];
  return (
    <div className="flex flex-col gap-3">
      {latest ? (
        <pre className="max-h-72 overflow-auto rounded border border-slate-800 bg-[#05080d] p-3 font-mono text-[10px] text-indigo-200 custom-scrollbar">
          {JSON.stringify({ type: latest.type, timestamp: latest.timestamp, payload: latest.payload }, null, 2)}
        </pre>
      ) : (
        <div className="font-mono text-[11px] text-slate-600">No EventBus payloads for this node yet.</div>
      )}
    </div>
  );
}

function nodeEventMatch(nodeId: string, type: string, payload: any): boolean {
  if (nodeId === 'market-data-worker') return type === 'MARKET_DATA';
  if (nodeId === 'technical-engine') {
    return type === 'MARKET_DATA' || type === 'TECHNICAL_ANALYSIS_STARTED' || type === 'TECHNICAL_ANALYSIS_COMPLETED'
      || (type === 'CALCULATION_COMPLETED' && isTechnicalEngineCalc(payload))
      || (type === 'TRADE_IDEA_GENERATED' && payload?.agent === 'TechnicalAgent');
  }
  if (nodeId === 'news-agent' || nodeId === 'news-providers' || nodeId === 'finbert-model' || nodeId === 'ollama-llm' || nodeId === 'paid-llm-pool') {
    return type === 'NEWS_ANALYSIS_STARTED' || type === 'NEWS_ANALYZED' || type === 'ESCALATION_DECISION' || type === 'AI_METRICS_UPDATE'
      || (type === 'TRADE_IDEA_GENERATED' && payload?.agent === 'NewsAgent');
  }
  if (nodeId === 'chief-trader') {
    return type === 'TRADE_IDEA_GENERATED' || type === 'CHIEF_CONSENSUS_STARTED' || type === 'CHIEF_CONSENSUS_COMPLETED' || type === 'CHIEF_APPROVED_IDEA';
  }
  if (nodeId === 'risk-manager') {
    return type === 'RISK_ASSESSMENT_STARTED' || type === 'RISK_GATE_EVALUATED' || type === 'RISK_ASSESSMENT_COMPLETED';
  }
  if (nodeId === 'capital-guard') return type === 'CAPITAL_CHECK' || (type === 'RISK_GATE_EVALUATED' && payload?.gate === 'argus_capital_allocation');
  if (nodeId === 'order-management') return type === 'ORDER_EXECUTED' || type === 'ORDER_SUBMITTED' || type === 'ORDER_ACCEPTED' || type === 'ORDER_FILLED';
  if (nodeId === 'kronos-forecast') return type === 'TRADE_IDEA_GENERATED' && payload?.agent === 'KronosEngine';
  if (nodeId === 'quant-engine') return type === 'TRADE_IDEA_GENERATED' && payload?.agent === 'QuantEngine';
  if (nodeId === 'fundamental-agent') return type === 'TRADE_IDEA_GENERATED' && payload?.agent === 'FundamentalAgent';
  if (nodeId === 'macro-agent') return type === 'TRADE_IDEA_GENERATED' && payload?.agent === 'MacroAgent';
  if (nodeId === 'portfolio-monitor') {
    return type === eventCatalog.POSITION_MONITORED || type === eventCatalog.POSITION_RISK_CHANGED || type === eventCatalog.PORTFOLIO_UPDATE
      || (type === eventCatalog.TRADE_IDEA_GENERATED && payload?.agent === agentWeights.riskExitAgent);
  }
  if (nodeId === 'learning-engine') return type === 'LEARNED_NEW_RULE';
  return false;
}

const TITLE: Record<string, string> = {
  'technical-engine': 'Technical Agent',
  'news-agent': 'News Agent',
  'news-providers': 'News Providers',
  'finbert-model': 'FinBERT',
  'ollama-llm': 'Ollama (local LLM)',
  'paid-llm-pool': 'Paid AI Pool',
  'chief-trader': 'Chief Trader',
  'risk-manager': 'Risk Engine',
};

type AgentFocusModeProps = {
  nodeId: string;
  nodeLabel: string;
  seedEvents: BusEvent[];
  weights: { agentName: string; currentWeight: number | null }[];
  onClose: () => void;
};

export default function AgentFocusMode({
  nodeId,
  nodeLabel,
  seedEvents,
  weights,
  onClose,
}: AgentFocusModeProps): React.ReactElement {
  const { subscribe } = useWebSocket();
  const [live, setLive] = useState<BusEvent[]>(() =>
    seedEvents.filter((e) => nodeEventMatch(nodeId, e.type, e.payload)).slice(0, 120),
  );
  const pending = useRef<BusEvent[]>([]);
  const raf = useRef<number | null>(null);

  const flush = useCallback(() => {
    raf.current = null;
    const batch = pending.current;
    pending.current = [];
    if (!batch.length) return;
    setLive((prev) => {
      let next = [...batch, ...prev];
      if (nodeId === 'technical-engine') {
        const ticks = next.filter((e) => e.type === 'MARKET_DATA').slice(0, SERIES_CAP);
        const calcs = next.filter((e) => e.type === 'CALCULATION_COMPLETED' || e.type === 'TECHNICAL_ANALYSIS_COMPLETED').slice(0, SERIES_CAP);
        const rest = next.filter((e) => e.type !== 'MARKET_DATA' && e.type !== 'CALCULATION_COMPLETED' && e.type !== 'TECHNICAL_ANALYSIS_COMPLETED');
        next = [...ticks, ...calcs, ...rest];
      }
      return next.slice(0, 160);
    });
  }, [nodeId]);

  useEffect(() => {
    const types = [
      'MARKET_DATA', 'CALCULATION_COMPLETED', 'TECHNICAL_ANALYSIS_STARTED', 'TECHNICAL_ANALYSIS_COMPLETED',
      'TRADE_IDEA_GENERATED', 'NEWS_ANALYSIS_STARTED', 'NEWS_ANALYZED', 'ESCALATION_DECISION', 'UI_UPDATE',
      'CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'CHIEF_APPROVED_IDEA',
      'RISK_ASSESSMENT_STARTED', 'RISK_GATE_EVALUATED', 'RISK_ASSESSMENT_COMPLETED',
      'CAPITAL_CHECK', 'ORDER_EXECUTED', 'ORDER_SUBMITTED', 'ORDER_ACCEPTED', 'ORDER_FILLED',
      'LEARNED_NEW_RULE', eventCatalog.POSITION_MONITORED, eventCatalog.POSITION_RISK_CHANGED, eventCatalog.PORTFOLIO_UPDATE,
    ].filter(Boolean);

    const unsubs = types.map((type) => subscribe(type, (data: any) => {
      const mappedType = type === 'UI_UPDATE' && data?.type === 'ai_metrics_update' ? 'AI_METRICS_UPDATE' : type;
      const payload = mappedType === 'AI_METRICS_UPDATE' ? (data?.payload ?? data) : data;
      if (type === 'UI_UPDATE' && mappedType !== 'AI_METRICS_UPDATE') return;
      if (!nodeEventMatch(nodeId, mappedType, payload)) return;
      pending.current.push({ type: mappedType, timestamp: payload?.timestamp || new Date().toISOString(), payload });
      if (raf.current == null) raf.current = window.requestAnimationFrame(flush);
    }));

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unsubs.forEach((u) => u());
      window.removeEventListener('keydown', onKey);
      if (raf.current != null) window.cancelAnimationFrame(raf.current);
    };
  }, [flush, nodeId, onClose, subscribe]);

  const body = useMemo(() => {
    if (nodeId === 'technical-engine') return <TechnicalInternals events={live} />;
    if (nodeId === 'news-agent' || nodeId === 'news-providers' || nodeId === 'finbert-model' || nodeId === 'ollama-llm' || nodeId === 'paid-llm-pool') {
      return <NewsInternals events={live} nodeId={nodeId} />;
    }
    if (nodeId === 'chief-trader') return <ChiefInternals events={live} weights={weights} />;
    if (nodeId === 'risk-manager') return <RiskInternals events={live} />;
    return <GenericInternals events={live} />;
  }, [live, nodeId, weights]);

  return (
      <motion.div
        className="absolute inset-0 z-40 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: FOCUS_MS }}
      >
        <button type="button" aria-label="Close focus mode" className="absolute inset-0 cursor-default bg-[#0A0F16]/55 backdrop-blur-md" onClick={onClose} />
        <motion.div
          layoutId={`agent-node-${nodeId}`}
          className="relative z-10 flex max-h-[92%] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-cyan-500/25 bg-[#1A1F2B] font-mono shadow-[0_0_48px_rgba(34,211,238,0.12)]"
          initial={{ opacity: 0.85, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: FOCUS_MS, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-center justify-between border-b border-slate-800 bg-[#0A0F16] px-4 py-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">Focus Mode</div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-white">{TITLE[nodeId] || nodeLabel}</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-200 hover:border-cyan-500 hover:text-white"
            >
              <ArrowLeft size={14} />
              Close / Back to Network
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar">
            {body}
            <div className="mt-4 flex items-center gap-2 font-mono text-[9px] text-slate-600">
              <Terminal size={12} />
              {live.length} buffered events · ticks coalesced on rAF · {fmtTs(live[0]?.timestamp)}
              <ShieldCheck size={12} className="ml-2" />
              zero fabricated series
            </div>
          </div>
        </motion.div>
      </motion.div>
  );
}
