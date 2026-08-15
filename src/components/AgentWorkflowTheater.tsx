/**
 * ==========================================================
 * Module: AgentWorkflowTheater.tsx
 *
 * Purpose:
 * Educational, per-agent motion scenes that show HOW each real Argus node works
 * (inputs → work → TRADE_IDEA or gate → next hop). This is architecture theater,
 * not a second Digital Twin. Live WebSocket events only pulse the matching card;
 * the looping animation itself is a replay of the documented pipeline, not a
 * fabricated tick stream or a 2022 debate.
 *
 * Honest labels:
 *   - QuantEngine is off unless QUANT_ENGINE_ENABLED=true
 *   - SMC is experimental / UNVALIDATED
 *   - MarketRegimeAgent / AdvancedQuantEngines emit telemetry that the live
 *     decision path does not consume
 *   - NewsAgent numbers here are illustrative of the workflow, not live accuracy
 *
 * Never:
 *   - Place orders, call AIRouter, or invent live P&L
 *   - Replace DigitalTwinVisualizer (that graph still lights from real events)
 * ==========================================================
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity, BookOpen, BrainCircuit, Cpu, DollarSign, Layers, Newspaper,
  Pause, Play, Send, ShieldCheck, SkipForward, TrendingUp, UserCheck, Clock, Sparkles,
} from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext';
import eventCatalog from '../../config/eventNames.json';

type PathRole = 'live' | 'opt-in' | 'unused';

interface AgentSpec {
  id: string;
  name: string;
  file: string;
  cadence: string;
  role: PathRole;
  accent: string;
  glow: string;
  liveEvents: string[];
  ideaAgentNames?: string[];
  steps: { title: string; detail: string }[];
}

const AGENTS: AgentSpec[] = [
  {
    id: 'market',
    name: 'Market Data',
    file: 'MarketDataWorker / Alpaca WS',
    cadence: 'Tick-driven',
    role: 'live',
    accent: '#38bdf8',
    glow: 'rgba(56,189,248,0.45)',
    liveEvents: ['MARKET_DATA', 'MARKET_DATA_UPDATED'],
    steps: [
      { title: 'Tick in', detail: 'Alpaca WebSocket quote/trade for a subscribed symbol.' },
      { title: 'Normalize', detail: 'symbol, price, volume, timestamp — no fabricated bars.' },
      { title: 'Emit', detail: 'EventBus MARKET_DATA (+ MARKET_DATA_UPDATED) fans out to agents.' },
    ],
  },
  {
    id: 'technical',
    name: 'Technical Agent',
    file: 'src/server/services/TechnicalAgent.ts',
    cadence: 'MARKET_DATA listener',
    role: 'live',
    accent: '#34d399',
    glow: 'rgba(52,211,153,0.4)',
    liveEvents: ['TECHNICAL_ANALYSIS_STARTED', 'TECHNICAL_ANALYSIS_COMPLETED'],
    ideaAgentNames: ['TechnicalAgent'],
    steps: [
      { title: 'Bars', detail: 'Uses real OHLC already on the tape — RSI, MACD, Bollinger math.' },
      { title: 'Rules', detail: 'Setups fire only when their real conditions match (not always-on).' },
      { title: 'Idea', detail: 'TRADE_IDEA_GENERATED {side, confidence, reasoning, agent}.' },
    ],
  },
  {
    id: 'news',
    name: 'News Agent',
    file: 'NewsEngine + sentiment path',
    cadence: 'RSS / paid news APIs',
    role: 'live',
    accent: '#818cf8',
    glow: 'rgba(129,140,248,0.45)',
    liveEvents: ['NEWS_ANALYSIS_STARTED', 'NEWS_ANALYZED', 'ESCALATION_DECISION'],
    ideaAgentNames: ['NewsAgent'],
    steps: [
      { title: 'Ingest', detail: 'Real RSS + optional Finnhub/other paid feeds into news_articles.' },
      { title: 'Score', detail: 'Local FinBERT first; escalate via AIRouter only when policy says so.' },
      { title: 'Idea', detail: 'Sentiment-backed TRADE_IDEA. Accuracy is measured, not assumed.' },
    ],
  },
  {
    id: 'fundamental',
    name: 'Fundamental Agent',
    file: 'src/server/services/FundamentalAgent.ts',
    cadence: '~60s timer, tracked symbols',
    role: 'live',
    accent: '#f59e0b',
    glow: 'rgba(245,158,11,0.4)',
    liveEvents: [],
    ideaAgentNames: ['FundamentalAgent'],
    steps: [
      { title: 'Fundamentals', detail: 'AlphaVantage (and peers) for P/E, EPS, growth — not guessed.' },
      { title: 'AIRouter', detail: 'Narrative wrap through the shared router, never a direct LLM SDK.' },
      { title: 'Idea', detail: 'TRADE_IDEA_GENERATED into the same ChiefTrader inbox as everyone else.' },
    ],
  },
  {
    id: 'macro',
    name: 'Macro Agent',
    file: 'src/server/services/MacroAgent.ts',
    cadence: '~75s timer',
    role: 'live',
    accent: '#a78bfa',
    glow: 'rgba(167,139,250,0.45)',
    liveEvents: [],
    ideaAgentNames: ['MacroAgent'],
    steps: [
      { title: 'Macro tape', detail: 'CPI, rates, unemployment from the same market-data providers.' },
      { title: 'Regime color', detail: 'AIRouter interprets the print; it does not size the order.' },
      { title: 'Idea', detail: 'Directional TRADE_IDEA only — RiskEngine still owns authorization.' },
    ],
  },
  {
    id: 'quant',
    name: 'Quant Engine',
    file: 'src/server/services/QuantSignalAgent.ts',
    cadence: 'Timer; QUANT_ENGINE_ENABLED',
    role: 'opt-in',
    accent: '#22d3ee',
    glow: 'rgba(34,211,238,0.4)',
    liveEvents: [],
    ideaAgentNames: ['QuantEngine'],
    steps: [
      { title: 'Features', detail: 'Regime, MarketContext, GroupedScores, optional SMC snapshot.' },
      { title: 'Strategies', detail: 'Five core evaluateAll(); SMC only if QUANT_SMC_STRATEGY_ENABLED.' },
      { title: 'EV gate', detail: 'No idea if EV ≤ 0 or too few closed trades. Thesis is additive.' },
    ],
  },
  {
    id: 'kronos',
    name: 'Kronos Forecaster',
    file: 'src/server/services/KronosForecastAgent.ts',
    cadence: 'Local Chronos service',
    role: 'opt-in',
    accent: '#2dd4bf',
    glow: 'rgba(45,212,191,0.4)',
    liveEvents: ['MODEL_HEALTH'],
    ideaAgentNames: ['KronosEngine'],
    steps: [
      { title: 'Health', detail: 'Polls local ai:serve /health. Honest Warning if Chronos is down.' },
      { title: 'Forecast', detail: 'Numerical path via chronos-t5-mini — not an LLM price guess.' },
      { title: 'Idea', detail: 'Optional TRADE_IDEA. Does not bypass ChiefTrader or RiskEngine.' },
    ],
  },
  {
    id: 'portfolio',
    name: 'Portfolio Monitor',
    file: 'PortfolioMonitor + ThesisInvalidation',
    cadence: '~60s open positions',
    role: 'live',
    accent: '#fb7185',
    glow: 'rgba(251,113,133,0.4)',
    liveEvents: [eventCatalog.POSITION_MONITORED, eventCatalog.POSITION_RISK_CHANGED],
    ideaAgentNames: ['PortfolioManager'],
    steps: [
      { title: 'Mark', detail: 'Live price vs settings.takeProfitPct / trailingStopPct (same as backtest).' },
      { title: 'Thesis', detail: 'Config-driven invalidation (JSON rules, not strategy-id if-ladders).' },
      { title: 'Exit idea', detail: 'Emits a SELL idea into the pipeline — never a raw broker flatten.' },
    ],
  },
  {
    id: 'chief',
    name: 'Chief Trader',
    file: 'src/server/services/ChiefTraderAgent.ts',
    cadence: 'On TRADE_IDEA_GENERATED',
    role: 'live',
    accent: '#e879f9',
    glow: 'rgba(232,121,249,0.45)',
    liveEvents: ['CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'CHIEF_APPROVED_IDEA', 'AGENT_DISAGREEMENT'],
    steps: [
      { title: 'Weights', detail: 'agent_performance_stats.currentWeight, refreshed from DB.' },
      { title: 'Debate', detail: 'Optional multi-provider AIRouter.routeConsensus; HOLD can veto.' },
      { title: 'Threshold', detail: 'Approve only if weighted confidence clears the configured bar (~0.75).' },
    ],
  },
  {
    id: 'risk',
    name: 'Risk Engine',
    file: 'RiskAgent + RiskEngine.evaluateRisk',
    cadence: 'On CHIEF_APPROVED_IDEA',
    role: 'live',
    accent: '#f43f5e',
    glow: 'rgba(244,63,94,0.45)',
    liveEvents: ['RISK_ASSESSMENT_STARTED', 'RISK_GATE_EVALUATED', 'RISK_ASSESSMENT_COMPLETED'],
    steps: [
      { title: 'Price', detail: 'Refuses if there is no live price. All gates still recorded after first fail.' },
      { title: 'Ladder', detail: 'Emergency-stop, daily-loss, streak, drawdown, rate, hours, news, size…' },
      { title: 'Verdict', detail: 'Approve → OMS. Veto → audit trail. This is the last hard authorization.' },
    ],
  },
  {
    id: 'capital',
    name: 'Capital Guard',
    file: 'CapitalAllocation + RiskEngine gate',
    cadence: 'Inside risk / autobot start',
    role: 'live',
    accent: '#fbbf24',
    glow: 'rgba(251,191,36,0.4)',
    liveEvents: ['CAPITAL_CHECK'],
    steps: [
      { title: 'Split', detail: 'settings.budget is Argus allocation — not broker cash/equity.' },
      { title: 'Ceiling', detail: 'argus_capital_allocation gate blocks over-commitment of the slice.' },
      { title: 'Start', detail: 'TradingEngine.toggle() also checks budget vs buyingPower on enable.' },
    ],
  },
  {
    id: 'oms',
    name: 'Order Management',
    file: 'OrderManagementService + BrokerManager',
    cadence: 'On risk-approved idea',
    role: 'live',
    accent: '#14b8a6',
    glow: 'rgba(20,184,166,0.45)',
    liveEvents: ['ORDER_SUBMITTED', 'ORDER_ACCEPTED', 'ORDER_FILLED', 'ORDER_EXECUTED'],
    steps: [
      { title: 'Idempotent', detail: 'placeOrder through the active broker only — never a second path.' },
      { title: 'Fill poll', detail: 'Accept / partial / fill / cancel are real adapter events.' },
      { title: 'Persist', detail: 'trades row + ORDER_EXECUTED → UI wildcard broadcast.' },
    ],
  },
  {
    id: 'reflection',
    name: 'Reflection Engine',
    file: 'ReflectionEngine (~60s)',
    cadence: 'Post-trade timer',
    role: 'live',
    accent: '#94a3b8',
    glow: 'rgba(148,163,184,0.35)',
    liveEvents: ['LEARNED_NEW_RULE'],
    steps: [
      { title: 'Score', detail: 'Predictions vs subsequent price; updates agent_performance_stats weights.' },
      { title: 'Rules', detail: 'LLM rule text → learned_rules. Text is not yet injected into live prompts.' },
      { title: 'Feedback', detail: 'Weights flow back into ChiefTrader consensus — the learning that is live.' },
    ],
  },
  {
    id: 'explain',
    name: 'Explainability',
    file: 'src/server/services/ExplainabilityAgent.ts',
    cadence: 'On demand / trace',
    role: 'live',
    accent: '#67e8f9',
    glow: 'rgba(103,232,249,0.35)',
    liveEvents: [],
    steps: [
      { title: 'Trace', detail: 'Reads event_traces for one correlationId / traceId.' },
      { title: 'Narrative', detail: 'Human reconstruction of idea → chief → risk → fill. No hidden CoT dump.' },
      { title: 'UI', detail: 'Observatory / transaction views — never a second execution path.' },
    ],
  },
  {
    id: 'regime-llm',
    name: 'Market Regime (LLM)',
    file: 'src/server/services/MarketRegimeAgent.ts',
    cadence: 'Timer / LLM guess',
    role: 'unused',
    accent: '#64748b',
    glow: 'rgba(100,116,139,0.3)',
    liveEvents: [],
    steps: [
      { title: 'Guess', detail: 'LLM-labeled regime — distinct from price-derived RegimeEngine.' },
      { title: 'Emit', detail: 'Events exist. Nothing on the live path consumes them.' },
      { title: 'Status', detail: 'Shown so the topology is honest, not so it looks like a vote.' },
    ],
  },
];

const PIPELINE = ['market', 'technical', 'news', 'fundamental', 'macro', 'quant', 'chief', 'risk', 'capital', 'oms', 'reflection'] as const;

function roleBadge(role: PathRole) {
  if (role === 'live') return { t: 'ON LIVE PATH', c: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' };
  if (role === 'opt-in') return { t: 'OPT-IN', c: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' };
  return { t: 'NOT CONSUMED', c: 'text-slate-400 border-slate-600/40 bg-slate-800/60' };
}

/* ---------- shared stage chrome ---------- */

function StageChrome({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <div className="relative h-[340px] overflow-hidden rounded-xl border border-slate-800 bg-[#070b12]">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.07) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      <div
        className="pointer-events-none absolute -top-24 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full blur-3xl"
        style={{ background: accent, opacity: 0.12 }}
      />
      <div className="awt-scan pointer-events-none absolute inset-x-0 h-24 opacity-30" style={{ background: `linear-gradient(180deg, transparent, ${accent}33, transparent)` }} />
      {children}
    </div>
  );
}

function Candles() {
  const bars = [28, 42, 36, 58, 50, 72, 64, 80, 68, 90, 84, 76];
  return (
    <div className="absolute bottom-10 left-8 flex items-end gap-2">
      {bars.map((h, i) => (
        <motion.div
          key={i}
          className="w-2.5 rounded-sm"
          style={{ background: i % 3 === 0 ? '#f43f5e' : '#34d399', boxShadow: `0 0 8px ${i % 3 === 0 ? '#f43f5e66' : '#34d39966'}` }}
          initial={{ height: 8 }}
          animate={{ height: h }}
          transition={{ duration: 0.9, delay: i * 0.08, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' }}
        />
      ))}
    </div>
  );
}

function OrbitRing({ color, r, duration, reverse }: { color: string; r: number; duration: number; reverse?: boolean }) {
  return (
    <motion.div
      className="absolute left-1/2 top-1/2 rounded-full border"
      style={{ width: r, height: r, marginLeft: -r / 2, marginTop: -r / 2, borderColor: `${color}55` }}
      animate={{ rotate: reverse ? -360 : 360 }}
      transition={{ duration, repeat: Infinity, ease: 'linear' }}
    >
      <div className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full" style={{ background: color, boxShadow: `0 0 12px ${color}` }} />
    </motion.div>
  );
}

function Scene({ id, accent }: { id: string; accent: string }) {
  if (id === 'market') {
    return (
      <StageChrome accent={accent}>
        <Candles />
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            className="absolute h-2 w-2 rounded-full"
            style={{ background: accent, boxShadow: `0 0 10px ${accent}`, left: '12%', top: `${22 + i * 12}%` }}
            animate={{ x: [0, 520, 520], opacity: [0, 1, 0] }}
            transition={{ duration: 2.4, delay: i * 0.35, repeat: Infinity, ease: 'easeInOut' }}
          />
        ))}
        <div className="absolute right-8 top-10 font-mono text-[10px] uppercase tracking-[0.25em] text-sky-300">Alpaca WS · ticks</div>
      </StageChrome>
    );
  }
  if (id === 'technical') {
    return (
      <StageChrome accent={accent}>
        <Candles />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 640 340" fill="none">
          <motion.path
            d="M40 220 C 120 200, 180 240, 260 180 S 420 120, 600 90"
            stroke={accent}
            strokeWidth="2.5"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: [0, 1, 0.2] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          />
        </svg>
        <div className="absolute right-8 top-12 space-y-2 font-mono text-[10px] text-emerald-300">
          {['RSI', 'MACD', 'Bollinger'].map((l, i) => (
            <motion.div key={l} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1"
              animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.6, delay: i * 0.25, repeat: Infinity }}>
              {l}
            </motion.div>
          ))}
        </div>
      </StageChrome>
    );
  }
  if (id === 'news') {
    const headlines = ['CPI PRINT CROSSES TAPE', 'EARNINGS REVISION CLUSTER', 'FED SPEAK WINDOW', 'SECTOR FLOW HEADLINE'];
    return (
      <StageChrome accent={accent}>
        <div className="absolute inset-0 flex flex-col justify-center gap-3 px-10">
          {headlines.map((h, i) => (
            <motion.div
              key={h}
              className="flex items-center gap-3 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-2 font-mono text-[11px] text-indigo-100"
              initial={{ x: 80, opacity: 0 }}
              animate={{ x: [80, 0, -40], opacity: [0, 1, 0] }}
              transition={{ duration: 3.2, delay: i * 0.55, repeat: Infinity }}
            >
              <Newspaper size={12} className="text-indigo-400" />
              {h}
              <motion.span className="ml-auto text-[9px] text-emerald-400" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity }}>
                SENTIMENT
              </motion.span>
            </motion.div>
          ))}
        </div>
      </StageChrome>
    );
  }
  if (id === 'fundamental') {
    const metrics = ['P/E', 'EPS', 'REV', 'FCF'];
    return (
      <StageChrome accent={accent}>
        <div className="absolute inset-0 flex items-center justify-center">
          <OrbitRing color={accent} r={90} duration={8} />
          <OrbitRing color="#fbbf24" r={140} duration={12} reverse />
          <OrbitRing color="#fb923c" r={190} duration={16} />
          <div className="z-10 rounded-full border border-amber-400/40 bg-[#0A0F16] px-6 py-6 text-center">
            <div className="font-mono text-[10px] uppercase tracking-widest text-amber-300">Fundamentals</div>
            <div className="mt-1 text-lg font-bold text-white">AlphaVantage</div>
          </div>
        </div>
        {metrics.map((m, i) => (
          <motion.div
            key={m}
            className="absolute font-mono text-[10px] text-amber-200"
            style={{ left: `${18 + i * 20}%`, top: '18%' }}
            animate={{ y: [0, 8, 0], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, delay: i * 0.2, repeat: Infinity }}
          >
            {m}
          </motion.div>
        ))}
      </StageChrome>
    );
  }
  if (id === 'macro') {
    return (
      <StageChrome accent={accent}>
        <div className="absolute bottom-12 left-10 right-10 flex items-end justify-around gap-4">
          {['CPI', 'FFR', 'UNEMP', 'DXY'].map((lab, i) => (
            <div key={lab} className="flex flex-col items-center gap-2">
              <motion.div
                className="w-10 rounded-t-md"
                style={{ background: `linear-gradient(180deg, ${accent}, #1e1b4b)` }}
                animate={{ height: [40 + i * 12, 90 - i * 8, 50 + i * 10] }}
                transition={{ duration: 2.4, delay: i * 0.15, repeat: Infinity, repeatType: 'mirror' }}
              />
              <span className="font-mono text-[9px] tracking-widest text-violet-200">{lab}</span>
            </div>
          ))}
        </div>
      </StageChrome>
    );
  }
  if (id === 'quant') {
    const strats = ['MOM', 'PULL', 'MR', 'TREND', 'RANGE', 'SMC'];
    return (
      <StageChrome accent={accent}>
        <div className="absolute left-1/2 top-16 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300">
          Regime · Strategies · EV
        </div>
        <div className="absolute inset-0 flex items-center justify-center gap-3">
          {strats.map((s, i) => (
            <motion.div
              key={s}
              className={`flex h-20 w-16 flex-col items-center justify-center rounded-lg border font-mono text-[10px] ${s === 'SMC' ? 'border-amber-400/40 text-amber-300' : 'border-cyan-400/30 text-cyan-100'}`}
              animate={{ y: [0, -10, 0], boxShadow: [`0 0 0px ${accent}`, `0 0 18px ${accent}`, `0 0 0px ${accent}`] }}
              transition={{ duration: 1.8, delay: i * 0.12, repeat: Infinity }}
            >
              {s}
              {s === 'SMC' && <span className="mt-1 text-[7px] text-amber-500">UNVAL</span>}
            </motion.div>
          ))}
        </div>
      </StageChrome>
    );
  }
  if (id === 'kronos') {
    return (
      <StageChrome accent={accent}>
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 640 340">
          <motion.path d="M40 200 L 220 180 L 360 150" stroke="#94a3b8" strokeWidth="2" fill="none" />
          <motion.path
            d="M360 150 L 620 80 L 620 240 L 360 150"
            fill={`${accent}33`}
            stroke={accent}
            strokeWidth="1.5"
            initial={{ opacity: 0.2 }}
            animate={{ opacity: [0.2, 0.55, 0.2] }}
            transition={{ duration: 2.5, repeat: Infinity }}
          />
        </svg>
        <div className="absolute bottom-10 right-10 font-mono text-[10px] uppercase tracking-widest text-teal-300">Chronos cone · local</div>
      </StageChrome>
    );
  }
  if (id === 'portfolio') {
    return (
      <StageChrome accent={accent}>
        <div className="absolute left-12 right-12 top-1/2 h-px bg-rose-500/40" />
        <div className="absolute left-12 right-12 top-[38%] h-px border-t border-dashed border-emerald-400/50" />
        <div className="absolute left-12 right-12 top-[62%] h-px border-t border-dashed border-amber-400/50" />
        <motion.div
          className="absolute top-[48%] h-4 w-4 rounded-full bg-rose-400"
          style={{ boxShadow: '0 0 16px #fb7185' }}
          animate={{ left: ['12%', '70%', '40%'] }}
          transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="absolute left-12 top-[32%] font-mono text-[9px] text-emerald-400">TAKE PROFIT</div>
        <div className="absolute left-12 top-[66%] font-mono text-[9px] text-amber-400">TRAIL / INVALIDATION</div>
      </StageChrome>
    );
  }
  if (id === 'chief') {
    const nodes = ['Tech', 'News', 'Fund', 'Macro', 'Quant'];
    return (
      <StageChrome accent={accent}>
        <div className="absolute inset-0 flex items-center justify-center">
          <OrbitRing color={accent} r={160} duration={14} />
          <motion.div
            className="z-10 flex h-28 w-28 flex-col items-center justify-center rounded-full border-2 border-fuchsia-400/60 bg-[#0A0F16]"
            animate={{ boxShadow: ['0 0 12px #e879f966', '0 0 36px #e879f9aa', '0 0 12px #e879f966'] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <UserCheck size={22} className="text-fuchsia-300" />
            <span className="mt-1 font-mono text-[9px] tracking-widest text-fuchsia-200">CONSENSUS</span>
          </motion.div>
        </div>
        {nodes.map((n, i) => (
          <motion.div
            key={n}
            className="absolute left-1/2 top-1/2 font-mono text-[10px] text-fuchsia-100"
            animate={{
              x: [Math.cos((i / nodes.length) * Math.PI * 2) * 120, Math.cos((i / nodes.length) * Math.PI * 2 + 0.4) * 120],
              y: [Math.sin((i / nodes.length) * Math.PI * 2) * 90, Math.sin((i / nodes.length) * Math.PI * 2 + 0.4) * 90],
            }}
            transition={{ duration: 3, delay: i * 0.1, repeat: Infinity, repeatType: 'mirror' }}
          >
            {n}
          </motion.div>
        ))}
      </StageChrome>
    );
  }
  if (id === 'risk') {
    const gates = ['STOP', 'P&L', 'STREAK', 'DD', 'RATE', 'HRS', 'NEWS', 'PX', 'SIZE', 'CORR', 'SELL'];
    return (
      <StageChrome accent={accent}>
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 px-4">
          {gates.map((g, i) => (
            <motion.div
              key={g}
              className="flex h-28 w-[7.5%] flex-col items-center justify-end rounded-md border border-rose-500/30 bg-rose-500/5"
              animate={{ borderColor: ['#881337', '#fb7185', '#881337'], backgroundColor: ['rgba(244,63,94,0.05)', 'rgba(244,63,94,0.25)', 'rgba(244,63,94,0.05)'] }}
              transition={{ duration: 0.7, delay: i * 0.18, repeat: Infinity }}
            >
              <span className="mb-2 rotate-[-70deg] font-mono text-[8px] tracking-wider text-rose-100">{g}</span>
            </motion.div>
          ))}
        </div>
      </StageChrome>
    );
  }
  if (id === 'capital') {
    return (
      <StageChrome accent={accent}>
        <div className="absolute inset-x-16 top-16 space-y-8">
          {[
            { l: 'BROKER EQUITY', w: '88%' },
            { l: 'ARGUS ALLOCATION', w: '42%' },
            { l: 'USED IN POSITIONS', w: '18%' },
          ].map((row, i) => (
            <div key={row.l}>
              <div className="mb-1 font-mono text-[9px] tracking-widest text-amber-200">{row.l}</div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-800">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: i === 0 ? '#64748b' : accent }}
                  initial={{ width: '8%' }}
                  animate={{ width: row.w }}
                  transition={{ duration: 1.6, delay: i * 0.2, repeat: Infinity, repeatType: 'mirror' }}
                />
              </div>
            </div>
          ))}
        </div>
      </StageChrome>
    );
  }
  if (id === 'oms') {
    return (
      <StageChrome accent={accent}>
        <div className="absolute left-10 top-1/2 -translate-y-1/2 rounded-xl border border-teal-400/40 bg-teal-500/10 px-4 py-3 font-mono text-[11px] text-teal-100">OMS</div>
        <div className="absolute right-10 top-1/2 -translate-y-1/2 rounded-xl border border-teal-400/40 bg-teal-500/10 px-4 py-3 font-mono text-[11px] text-teal-100">BROKER</div>
        <motion.div
          className="absolute top-1/2 h-4 w-16 -translate-y-1/2 rounded-full bg-teal-300"
          style={{ boxShadow: '0 0 18px #14b8a6' }}
          animate={{ left: ['22%', '72%'] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="absolute bottom-10 left-0 right-0 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-teal-400">
          submit · accept · fill
        </div>
      </StageChrome>
    );
  }
  if (id === 'reflection') {
    return (
      <StageChrome accent={accent}>
        <div className="absolute inset-0 flex items-center justify-center gap-10">
          <motion.div className="h-32 w-32 rounded-full border-2 border-slate-500" animate={{ rotate: 360 }} transition={{ duration: 10, repeat: Infinity, ease: 'linear' }}>
            <div className="flex h-full items-center justify-center font-mono text-[10px] text-slate-300">PREDICTION</div>
          </motion.div>
          <motion.div animate={{ x: [0, 8, 0] }} transition={{ duration: 1.2, repeat: Infinity }}>→</motion.div>
          <motion.div className="h-32 w-32 rounded-full border-2 border-emerald-400/50" animate={{ rotate: -360 }} transition={{ duration: 12, repeat: Infinity, ease: 'linear' }}>
            <div className="flex h-full items-center justify-center font-mono text-[10px] text-emerald-300">REALIZED</div>
          </motion.div>
        </div>
        <div className="absolute bottom-8 w-full text-center font-mono text-[10px] text-slate-400">WEIGHTS → CHIEF · RULE TEXT WRITE-ONLY</div>
      </StageChrome>
    );
  }
  if (id === 'explain') {
    return (
      <StageChrome accent={accent}>
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="absolute left-16 right-16 h-10 rounded-md border border-cyan-500/20 bg-cyan-500/5"
            style={{ top: 48 + i * 56 }}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: [0, 1, 1, 0], x: [-20, 0, 0, 12] }}
            transition={{ duration: 3.5, delay: i * 0.35, repeat: Infinity }}
          />
        ))}
        <div className="absolute bottom-8 w-full text-center font-mono text-[10px] tracking-widest text-cyan-300">TRACE ID NARRATIVE</div>
      </StageChrome>
    );
  }
  return (
    <StageChrome accent={accent}>
      <div className="absolute inset-0 flex items-center justify-center">
        <motion.div className="rounded-lg border border-slate-600 px-6 py-4 font-mono text-xs text-slate-400"
          animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 2, repeat: Infinity }}>
          TELEMETRY ONLY — NOT ON THE LIVE PATH
        </motion.div>
      </div>
    </StageChrome>
  );
}

const AGENT_ICON: Record<string, React.ReactNode> = {
  market: <Activity size={14} />,
  technical: <TrendingUp size={14} />,
  news: <Newspaper size={14} />,
  fundamental: <Layers size={14} />,
  macro: <Sparkles size={14} />,
  quant: <Cpu size={14} />,
  kronos: <BrainCircuit size={14} />,
  portfolio: <Clock size={14} />,
  chief: <UserCheck size={14} />,
  risk: <ShieldCheck size={14} />,
  capital: <DollarSign size={14} />,
  oms: <Send size={14} />,
  reflection: <BookOpen size={14} />,
  explain: <BookOpen size={14} />,
  'regime-llm': <BrainCircuit size={14} />,
};

export default function AgentWorkflowTheater() {
  const [selectedId, setSelectedId] = useState(AGENTS[0].id);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [liveHits, setLiveHits] = useState<Record<string, number>>({});

  const selected = AGENTS.find((a) => a.id === selectedId) || AGENTS[0];
  const badge = roleBadge(selected.role);

  useEffect(() => {
    setStep(0);
  }, [selectedId]);

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      setStep((s) => {
        const next = s + 1;
        if (next >= selected.steps.length) {
          const idx = AGENTS.findIndex((a) => a.id === selectedId);
          setSelectedId(AGENTS[(idx + 1) % AGENTS.length].id);
          return 0;
        }
        return next;
      });
    }, 2200);
    return () => window.clearInterval(t);
  }, [playing, selected.steps.length, selectedId]);

  const { subscribe } = useWebSocket();
  useEffect(() => {
    const bump = (agentId: string) => () => {
      setLiveHits((prev) => ({ ...prev, [agentId]: Date.now() }));
    };
    const unsubs: Array<() => void> = [];
    for (const agent of AGENTS) {
      for (const ev of agent.liveEvents) {
        unsubs.push(subscribe(ev, bump(agent.id)));
      }
    }
    unsubs.push(subscribe('TRADE_IDEA_GENERATED', (data: any) => {
      const name = data?.agent;
      const hit = AGENTS.find((a) => a.ideaAgentNames?.includes(name));
      if (hit) bump(hit.id)();
    }));
    unsubs.push(subscribe('MODEL_HEALTH', (data: any) => {
      if (data?.modelId === 'chronos-kronos') bump('kronos')();
    }));
    return () => unsubs.forEach((u) => u());
  }, [subscribe]);

  const now = Date.now();
  const pipelinePacketIndex = useMemo(() => {
    const i = PIPELINE.indexOf(selectedId as (typeof PIPELINE)[number]);
    return i < 0 ? 0 : i;
  }, [selectedId]);

  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-800 bg-[#1A1F2B]">
      <style>{`
        @keyframes awt-scan {
          0% { transform: translateY(-40%); }
          100% { transform: translateY(380%); }
        }
        .awt-scan { animation: awt-scan 5.5s linear infinite; }
      `}</style>

      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-white">
            <Sparkles size={15} className="text-indigo-400" />
            Agent Workflow Theater
          </h3>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-400">
            Animated walkthrough of how each real Argus node works. The looping scenes are educational
            (architecture, not live ticks). Cards pulse when a matching WebSocket event actually fires.
            Live node graph remains Digital Twin below. Quant stays off unless enabled in env.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="flex items-center gap-1.5 rounded border border-slate-700 bg-[#0A0F16] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-200 hover:border-indigo-500/50"
          >
            {playing ? <Pause size={12} /> : <Play size={12} />}
            {playing ? 'Pause tour' : 'Play tour'}
          </button>
          <button
            type="button"
            onClick={() => {
              const idx = AGENTS.findIndex((a) => a.id === selectedId);
              setSelectedId(AGENTS[(idx + 1) % AGENTS.length].id);
            }}
            className="flex items-center gap-1.5 rounded border border-slate-700 bg-[#0A0F16] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-200 hover:border-indigo-500/50"
          >
            <SkipForward size={12} /> Next
          </button>
        </div>
      </div>

      <div className="relative overflow-hidden border-b border-slate-800 bg-[#0A0F16] px-3 py-3">
        <div className="flex items-center gap-1">
          {PIPELINE.map((id, i) => {
            const a = AGENTS.find((x) => x.id === id)!;
            const on = id === selectedId;
            return (
              <React.Fragment key={id}>
                {i > 0 && <div className="h-px flex-1 bg-slate-800" />}
                <button
                  type="button"
                  onClick={() => setSelectedId(id)}
                  className={`whitespace-nowrap rounded-full px-2 py-1 font-mono text-[8px] uppercase tracking-wider ${on ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-500'}`}
                >
                  {a.name.split(' ')[0]}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <motion.div
          className="pointer-events-none absolute bottom-1 h-1 w-8 rounded-full bg-indigo-400"
          style={{ boxShadow: '0 0 12px #818cf8' }}
          animate={{ left: `${(pipelinePacketIndex / Math.max(PIPELINE.length - 1, 1)) * 88 + 4}%` }}
          transition={{ type: 'spring', stiffness: 80, damping: 18 }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-8">
        {AGENTS.map((a) => {
          const live = now - (liveHits[a.id] || 0) < 3500;
          const on = a.id === selectedId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setSelectedId(a.id)}
              className={`relative overflow-hidden rounded-lg border px-2 py-2 text-left transition-all ${on ? 'border-indigo-400/60 bg-indigo-500/10' : 'border-slate-800 bg-[#0A0F16] hover:border-slate-600'}`}
              style={live ? { boxShadow: `0 0 18px ${a.glow}` } : undefined}
            >
              {live && (
                <motion.div
                  className="absolute inset-0"
                  initial={{ opacity: 0.5 }}
                  animate={{ opacity: [0.45, 0] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                  style={{ background: a.glow }}
                />
              )}
              <div className="relative flex items-center gap-1.5">
                <span style={{ color: a.accent }}>{AGENT_ICON[a.id]}</span>
                <span className="truncate font-mono text-[9px] font-bold uppercase tracking-wide text-white">{a.name}</span>
              </div>
              <div className={`relative mt-1 text-[8px] font-mono ${a.role === 'unused' ? 'text-slate-500' : 'text-slate-400'}`}>
                {roleBadge(a.role).t}
                {live ? ' · LIVE PULSE' : ''}
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <AnimatePresence mode="wait">
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35 }}
            >
              <Scene id={selected.id} accent={selected.accent} />
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-0.5 font-mono text-[9px] tracking-widest ${badge.c}`}>{badge.t}</span>
            <span className="font-mono text-[10px] text-slate-500">{selected.cadence}</span>
          </div>
          <h4 className="text-lg font-bold text-white">{selected.name}</h4>
          <p className="mt-1 font-mono text-[10px] text-slate-500">{selected.file}</p>
          <ol className="mt-5 space-y-3">
            {selected.steps.map((s, i) => {
              const active = i === step;
              return (
                <li key={s.title} className={`rounded-lg border p-3 transition-all ${active ? 'border-indigo-400/50 bg-indigo-500/10' : 'border-slate-800 bg-[#0A0F16]'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] ${active ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-500'}`}>
                      {i + 1}
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-200">{s.title}</span>
                  </div>
                  <p className="mt-1.5 pl-7 text-[11px] leading-relaxed text-slate-400">{s.detail}</p>
                  {active && (
                    <motion.div className="mt-2 ml-7 h-0.5 rounded-full" style={{ background: selected.accent }}
                      initial={{ width: 0 }} animate={{ width: '70%' }} transition={{ duration: 2.1 }} />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
