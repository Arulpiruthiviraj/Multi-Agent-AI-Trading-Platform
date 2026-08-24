/**
 * Argus Historical Evaluation — MODE B full Argus replay. Not VectorBT. Not LIVE. Not paper.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, AlertTriangle, Play, Pause, Square, StepForward, Download, Info } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const CAPITAL_PRESETS = [100, 1000, 10000, 100000];

// Centralized replay timestamp formatter - every raw epoch-ms value shown in this component
// (trades table, event timeline) goes through this so they all render in the same timezone
// (the replay's own config.timezone, same convention marketSession.ts uses server-side via
// Intl.DateTimeFormat, not the viewer's local browser timezone).
function formatReplayTimestamp(ms: number, timeZone: string): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return String(ms ?? '—');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// Five CORE quant strategies (config/quantExperimentalStrategies.json core set / CLAUDE.md).
// "ALL_CORE" is a UI-only convenience that expands to this CSV - the backend only ever sees the
// same comma-joined strategyIds string createAndStart() already sent before this refactor.
const CORE_STRATEGY_IDS = ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION'];
const CORE_STRATEGY_CSV = CORE_STRATEGY_IDS.join(',');
const STRATEGY_OPTIONS = ['ALL_CORE', ...CORE_STRATEGY_IDS];

const MARKET_OPTIONS = ['US', 'CRYPTO'];
const EXCHANGE_OPTIONS = ['NYSE', 'NASDAQ', 'AMEX', 'ALL'];
const TIMEZONE_OPTIONS = ['America/New_York', 'UTC', 'America/Chicago', 'America/Los_Angeles'];
// Real registered ids only (HistoricalDataProviderRegistry.ts) - 'alpaca_historical' and
// 'local_parquet' are not registered providers and would resolve to DATA_PROVIDER_UNAVAILABLE.
// 'ibkr' is only AVAILABLE while IB Gateway is the actively connected broker (BrokerManager
// registers the reqHistoricalData bridge on broker switch); otherwise it also resolves to
// DATA_PROVIDER_UNAVAILABLE, same as any other listed-but-not-connected provider.
const DATA_PROVIDER_OPTIONS = ['golden_replay', 'alpaca', 'ibkr'];
// value must match FullArgusReplayEngine.ts's freqOk check (replaySafety.supportedFrequencies,
// case-insensitive, plus a literal '1Day' fallback) - label is just the readable form.
const FREQUENCY_OPTIONS = [
  { value: '1Day', label: '1Day' },
  { value: '1h', label: '1Hour' },
  { value: '15m', label: '15Min' },
  { value: '5m', label: '5Min' },
  { value: '1m', label: '1Min' },
];
// value must match ReplayAiMode (ReplayContext.ts) exactly - the backend does not know
// "SHADOW"/"ACTIVE_DEBATE"; these are the real supported modes.
const AI_MODE_OPTIONS = [
  { value: 'DISABLED', label: 'DISABLED' },
  { value: 'RECORDED_DECISION_REPLAY', label: 'RECORDED_DECISION_REPLAY' },
  { value: 'LIVE_MODEL_REPLAY', label: 'LIVE_MODEL_REPLAY' },
];
// value must match FullArgusReplayEngine.ts's speed checks ('1x'/'10x'/'100x'/'STEP'); any other
// value (including '50x') falls through to no per-tick delay, same as 'MAX'.
const SPEED_OPTIONS = [
  { value: 'MAX', label: 'Max (Instant)' },
  { value: '100x', label: '100x' },
  { value: '50x', label: '50x' },
  { value: '10x', label: '10x' },
  { value: '1x', label: '1x (Real-time)' },
];

// Copy verified against FullArgusReplayEngine.ts / HistoricalReplayBroker.ts / marketSession.ts /
// HistoricalDataProviderRegistry.ts / config/replaySafety.json - not aspirational feature copy.
// Where a field is genuinely inert (market, exchange), the tooltip says so rather than inventing
// a behavior the engine does not implement.
const FIELD_TIPS: Record<string, string> = {
  initialCapital: 'Starting cash balance for the replay portfolio (real broker equity in HistoricalReplayBroker). This is the hard cap on fills - a larger Allocation Budget passes the capital-allocation risk gate but the order still gets rejected for insufficient buying power if it exceeds this.',
  startDate: 'Historical date range to simulate. Bars are strictly bounded to [startDate, endDate] - there is no earlier warm-up buffer, so indicators needing a long lookback (e.g. a 50-bar SMA) may be unavailable until enough bars accumulate after startDate.',
  endDate: 'Historical date range to simulate. Bars are strictly bounded to [startDate, endDate] - there is no earlier warm-up buffer, so indicators needing a long lookback (e.g. a 50-bar SMA) may be unavailable until enough bars accumulate after startDate.',
  startTime: 'Clock time (in TIMEZONE) marking the start of startDate / end of endDate - bounds the whole simulated period, not a recurring daily filter. Which hours count as tradable each day is controlled separately by Extended Hours.',
  endTime: 'Clock time (in TIMEZONE) marking the start of startDate / end of endDate - bounds the whole simulated period, not a recurring daily filter. Which hours count as tradable each day is controlled separately by Extended Hours.',
  market: 'Not yet enforced by the replay engine - stored with the run but does not currently filter data or session rules. Selecting CRYPTO does not enable 24/7 sessions in this build.',
  exchange: 'Not yet enforced by the replay engine - stored with the run but does not currently apply venue-specific holiday/session calendars.',
  timezone: "Reference timezone used to classify each bar's market session (regular / pre-market / after-hours) and weekday. Default America/New_York matches Argus's live session logic.",
  frequency: 'Bar resolution. golden_replay only ever returns 1Day fixture bars regardless of this setting; intraday resolutions (1Hour/15Min/5Min/1Min) require the alpaca provider with real ALPACA_API_KEY/ALPACA_SECRET_KEY configured.',
  dataProvider: 'Historical data source. golden_replay = deterministic fixture bars for accounting/look-ahead tests, not real market data. alpaca = real IEX bars via Alpaca (requires API keys). ibkr = real IB Gateway reqHistoricalData bars, cached in ohlcv_bars — only AVAILABLE while IB Gateway is the currently connected/active broker, otherwise DATA_PROVIDER_UNAVAILABLE. Polygon/Twelve Data/Alpha Vantage are listed in Data Providers below but are not implemented and return DATA_PROVIDER_UNAVAILABLE.',
  allocationBudget: "Ceiling Argus's own capital-allocation risk gate enforces on top of Initial Capital (budget minus open positions minus pending BUYs). It does not add real buying power - fills still need enough actual cash in Initial Capital.",
  costProfile: 'Slippage/commission/spread model from config/replaySafety.json. Base & REALISTIC_COST: $0.005/share, 2bps spread, 5bps slippage. Conservative: $0.01/share, 5bps/10bps. Optimistic: near-zero (1bps/1bps). ZERO_COST_RESEARCH: 0/0/0 - theoretical only, flagged as not live-readiness evidence. CUSTOM_COST currently mirrors Base.',
  aiMode: 'DISABLED (default) runs deterministic quant rules only - no LLM calls, no fabricated votes. RECORDED_DECISION_REPLAY and LIVE_MODEL_REPLAY route through the real AIRouter, subject to replaySafety.json aiCallLimit/aiCostLimitUsd/aiTimeoutMs.',
  strategyIds: 'Quant strategy to evaluate. ALL_CORE runs all five CORE strategies (MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION, MEAN_REVERSION, TREND_FOLLOWING, RANGE_REVERSION) - the same set live evaluateAll() runs. Backtests are long-only; bearish setups will not open shorts unless Short Selling is also enabled.',
  speed: 'Playback pacing between processed bars. Max = no artificial delay. 100x/10x/1x add a fixed per-bar delay (10ms/100ms/1000ms) for visualization. 50x currently behaves identically to Max - no dedicated delay is wired for it yet.',
  shortSelling: 'When enabled, allows a SELL to open a negative (short) position instead of only closing an existing long. Off by default - Argus backtests are otherwise long-only.',
  fractionalShares: 'When enabled, position sizing allows non-integer share quantities. When disabled (default), quantity is floored to whole shares - matching live Alpaca order behavior (Math.floor(dollars / price)).',
  extendedHours: 'Includes pre-market (04:00-09:30 ET) and after-hours (16:00-20:00 ET) bars as fillable sessions (config/replaySafety.json), on top of the default regular session (09:30-16:00 ET). Uses TIMEZONE for session boundaries.',
};

function FieldLabel({ text, tip }: { text: string; tip?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {text}
      {tip && (
        <span className="group relative inline-flex">
          <Info
            size={11}
            tabIndex={0}
            aria-label={`${text} info`}
            className="text-slate-500 hover:text-blue-400 focus:text-blue-400 focus:outline-none cursor-help"
          />
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-64 -translate-x-1/2 rounded border border-slate-700 bg-[#0f172a] p-2 text-[10px] normal-case leading-relaxed tracking-normal text-slate-200 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            {tip}
          </span>
        </span>
      )}
    </span>
  );
}

// Fade-in-slide keyframe for newly-mounted trade/event rows. React keys keep existing rows'
// DOM nodes stable across polls, so this only plays once per row on its actual first mount -
// not replayed on every 750ms poll tick.
const REPLAY_ANIM_STYLE = `
@keyframes replayRowFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.replay-row-fade-in { animation: replayRowFadeIn 0.25s ease-out; }
`;

function StatusBadge({ status }: { status?: string }) {
  const s = status || 'NOT RUN';
  const dot = s === 'RUNNING' ? 'bg-emerald-400'
    : s === 'PAUSED' ? 'bg-amber-400'
    : s === 'COMPLETED' ? 'bg-slate-400'
    : s === 'FAILED' || s === 'CANCELLED' ? 'bg-rose-400'
    : 'bg-slate-600';
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-300">
      <span className="relative flex h-2 w-2">
        {s === 'RUNNING' && <span className={`absolute inline-flex h-full w-full rounded-full ${dot} opacity-75 animate-ping`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {s}
    </span>
  );
}

// Real fields only (totalBars/currentBarIndex/currentTimestamp set in FullArgusReplayEngine.ts's
// tick loop, surfaced by GET /research/replay/:id) - renders nothing rather than a fabricated
// percentage when the run hasn't started producing them yet.
function ReplayProgressBar({ run, timezone }: { run: any; timezone: string }) {
  if (!run || run.totalBars == null || run.currentBarIndex == null || run.totalBars <= 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round((run.currentBarIndex / run.totalBars) * 100)));
  const isRunning = run.status === 'RUNNING';
  const dateLabel = run.currentTimestamp != null ? formatReplayTimestamp(run.currentTimestamp, timezone).slice(0, 10) : '—';
  return (
    <div className="mb-3">
      <div className="flex flex-wrap justify-between gap-1 text-[10px] font-mono text-slate-400 mb-1">
        <span>Simulating: {dateLabel}</span>
        <span>{pct}% Complete | {run.currentBarIndex.toLocaleString()} / {run.totalBars.toLocaleString()} bars</span>
      </div>
      <div className="h-2 w-full bg-slate-800 rounded overflow-hidden">
        <div
          className={`h-full rounded transition-[width] duration-300 ${isRunning ? 'bg-indigo-500 animate-pulse' : 'bg-indigo-700'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone, sub, tip }: { label: string; value: React.ReactNode; tone?: 'good' | 'bad' | 'neutral'; sub?: React.ReactNode; tip?: string }) {
  const toneClass = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-white';
  return (
    <div className="bg-[#0b101b] border border-slate-800 rounded p-3 flex flex-col gap-1">
      <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500"><FieldLabel text={label} tip={tip} /></div>
      <div className={`text-sm font-mono font-bold ${toneClass}`}>{value}</div>
      {sub && <div className="text-[10px] font-mono text-slate-500">{sub}</div>}
    </div>
  );
}

// UI-only heuristic buckets for a quick read - explicitly labeled as such, and distinct from the
// real RiskEngine gate `portfolio_drawdown` (settings.maxPortfolioDrawdownPct), which this does
// not read or represent.
function drawdownRiskLabel(pctAbs: number): string {
  if (pctAbs < 5) return 'Low';
  if (pctAbs < 15) return 'Moderate';
  return 'High';
}

// Ratio-quality label only ever shown when report.sharpe/sortino.status === 'OK' (a real computed
// value past replaySafety.json's minSharpeTrades/minSortinoTrades floor) - never applied to an
// INSUFFICIENT_SAMPLE placeholder.
function ratioQualityLabel(value: number): string {
  if (value < 1.0) return 'Suboptimal / High Volatility';
  if (value < 2.0) return 'Good / Acceptable Risk-Adjusted Return';
  return 'Excellent Institutional Performance';
}

const NO_TRADE_REASON_EXPLANATION: Record<string, string> = {
  NO_VALID_STRATEGY: 'the selected strategy never produced a valid entry setup on this data (NO_VALID_STRATEGY) - the indicator/quant rule conditions were never met',
  NO_CHIEF_APPROVAL: 'the proposals that were generated did not reach ChiefTrader consensus quorum (NO_CHIEF_APPROVAL)',
  INSUFFICIENT_SAMPLE: 'there were not yet enough bars for the strategy to evaluate (INSUFFICIENT_SAMPLE)',
  DATA_UNAVAILABLE: 'historical bar data was unavailable for the requested symbols/frequency (DATA_UNAVAILABLE)',
  RISK_REJECTED: 'ideas reached RiskEngine but were rejected there (RISK_REJECTED) - the risk engine remained fail-closed to protect capital',
  DUPLICATE_SIGNAL: 'repeated signals were suppressed as duplicates within the cooldown window (DUPLICATE_SIGNAL)',
  NO_POSITION: 'exit signals fired with no open position to close (NO_POSITION)',
};

// Composed entirely from real report/noTrade fields already computed server-side - no invented
// numbers. When totalTrades is 0, explains the ACTUAL dominant noTrade reason for this run rather
// than generic boilerplate.
function buildExecutiveSummary(report: any, noTrade: Record<string, number>, strategyLabel: string): string[] {
  if (!report) return [];
  if (!report.totalTrades) {
    const lines = ['No trades were executed during this period.'];
    const entries = Object.entries(noTrade).filter(([, v]) => (v as number) > 0).sort((a, b) => (b[1] as number) - (a[1] as number));
    if (entries.length) {
      const [reason] = entries[0];
      lines.push(`This is because ${NO_TRADE_REASON_EXPLANATION[reason] || `of ${reason}`}. The risk engine remained fail-closed to protect capital.`);
    }
    lines.push('Try a different date range, a lower bar frequency (e.g. 1Day instead of 1Min), or ALL_CORE to widen the strategy set.');
    return lines;
  }
  const sign = report.netPnl >= 0 ? '+' : '';
  const s1 = `${strategyLabel} completed ${report.totalTrades} trade${report.totalTrades === 1 ? '' : 's'}` +
    `${report.winRate != null ? ` with a ${(report.winRate * 100).toFixed(1)}% win rate` : ''}, ` +
    `delivering a net return of ${sign}$${Number(report.netPnl).toFixed(2)} (${sign}${Number(report.netReturnPct).toFixed(2)}%).`;
  const ddAbs = Math.abs(report.maxDrawdownPct ?? 0);
  const s2 = `Max drawdown was ${ddAbs <= 2 ? 'tightly contained' : ddAbs <= 10 ? 'moderate' : 'significant'} at -${ddAbs.toFixed(2)}%.`;
  return [s1, s2, 'This is a HISTORICAL_SIMULATION result only - not organic paper evidence and not proof of future or LIVE performance.'];
}

function EquityChart({ equity, timezone, isRunning }: { equity: Array<{ t: number; equity: number; cash: number; drawdownPct: number }>; timezone: string; isRunning: boolean }) {
  if (!equity.length) return <div className="text-[10px] font-mono text-slate-500">NO DATA</div>;
  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={equity} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(t) => formatReplayTimestamp(Number(t), timezone).slice(5, 10)}
          tick={{ fontSize: 9, fill: '#64748b' }}
          axisLine={{ stroke: '#1e293b' }}
          tickLine={false}
          minTickGap={30}
        />
        <YAxis
          tick={{ fontSize: 9, fill: '#64748b' }}
          axisLine={{ stroke: '#1e293b' }}
          tickLine={false}
          domain={['auto', 'auto']}
          width={56}
        />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', fontSize: 10, fontFamily: 'monospace' }}
          labelFormatter={(t) => formatReplayTimestamp(Number(t), timezone)}
          formatter={(v: number) => [`$${Number(v).toFixed(2)}`, 'Equity']}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#6366f1"
          fill="#6366f1"
          fillOpacity={0.15}
          strokeWidth={1.5}
          isAnimationActive
          dot={(props: any) => {
            const isLast = props.index === equity.length - 1;
            if (!isLast) return <circle key={props.index} cx={props.cx} cy={props.cy} r={0} />;
            return (
              <g key={props.index}>
                {isRunning && <circle cx={props.cx} cy={props.cy} r={7} fill="#34d399" opacity={0.35} className="animate-ping" />}
                <circle cx={props.cx} cy={props.cy} r={3} fill="#34d399" />
              </g>
            );
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function HistoricalReplayLab() {
  const [providers, setProviders] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [equity, setEquity] = useState<any[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Real perf fix (2026-08-18): the 750ms replay-status poll fired 4 concurrent fetches with no
  // cancellation between ticks - self-limiting (stops at a terminal run status) but still able to
  // pile up pending requests if any single tick runs long.
  const pollAbortRef = useRef<AbortController | null>(null);
  const [universeMode, setUniverseMode] = useState<'ARGUS_DISCOVERY' | 'OPERATOR_SELECTED'>('ARGUS_DISCOVERY');
  const [form, setForm] = useState({
    startDate: '2024-01-02',
    endDate: '2024-06-28',
    startTime: '09:30:00',
    endTime: '16:00:00',
    market: 'US',
    exchange: 'NYSE',
    timezone: 'America/New_York',
    symbols: 'AAPL',
    frequency: '1Day',
    dataProvider: 'golden_replay',
    initialCapital: '100000',
    allocationBudget: '3000',
    costProfile: 'Base',
    aiMode: 'DISABLED',
    strategyIds: 'MOMENTUM_BREAKOUT',
    shortSelling: false,
    fractionalShares: false,
    extendedHours: false,
    speed: 'MAX',
  });

  useEffect(() => {
    fetch('/api/v2/research/replay/providers', { credentials: 'same-origin' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(j.error || `providers HTTP ${r.status}`);
          setProviders([]);
          return;
        }
        setProviders(j.providers || []);
      })
      .catch((e) => setError(e.message));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollAbortRef.current?.abort('component-unmounted');
    };
  }, []);

  // Real bug fixed: refreshRun can be called again (by the 750ms poll tick) before a prior call's
  // own fetches have resolved - e.g. when the server-side status/trades/events/equity requests
  // take longer than 750ms. The prior call's Promise.all then rejects with AbortError once this
  // newer call aborts its signal, and that rejection used to propagate all the way out to
  // createAndStart's try/catch, which displayed it as a real error via setError(e.message) - the
  // browser's default AbortError message, literally "signal is aborted without reason". Being
  // superseded by a newer poll is expected, benign concurrency, not a failure: swallow exactly
  // that case (this call's own signal aborting) and return null so callers skip processing this
  // stale response instead of surfacing it as an error. Any other thrown error still propagates.
  const refreshRun = useCallback(async (replayId: string) => {
    pollAbortRef.current?.abort('superseded-by-newer-replay-status-request');
    const controller = new AbortController();
    pollAbortRef.current = controller;
    const { signal } = controller;
    try {
      const [status, tradesRes, eventsRes, equityRes] = await Promise.all([
        fetch(`/api/v2/research/replay/${replayId}`, { signal }).then((r) => r.json()),
        fetch(`/api/v2/research/replay/${replayId}/trades`, { signal }).then((r) => r.json()).catch(() => ({ trades: [] })),
        fetch(`/api/v2/research/replay/${replayId}/events`, { signal }).then((r) => r.json()).catch(() => ({ events: [] })),
        fetch(`/api/v2/research/replay/${replayId}/equity`, { signal }).then((r) => r.json()).catch(() => ({ equity: [] })),
      ]);
      setRun(status);
      setTrades(tradesRes.trades || status.trades || []);
      setEvents((eventsRes.events || status.events || []).slice(-80));
      setEquity(equityRes.equity || status.equity || []);
      return status;
    } catch (e: any) {
      if (e?.name === 'AbortError' || signal.aborted) return null;
      throw e;
    }
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(replayId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await refreshRun(replayId);
        if (!status) return; // superseded by a newer tick's request; that one will update state instead
        const terminal = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DATA_UNAVAILABLE'].includes(status.status);
        // Wait until performance report is attached (COMPLETED used to race ahead of report build).
        if (terminal && (status.report || status.status !== 'COMPLETED' && status.status !== 'PARTIAL')) {
          stopPolling();
          setBusy(false);
        } else if (terminal && !status.report) {
          const rep = await fetch(`/api/v2/research/replay/${replayId}/report`).then((r) => r.json()).catch(() => null);
          if (rep?.report) {
            setRun((prev: any) => ({ ...prev, ...status, report: rep.report, rejectedOrders: status.rejectedOrders || rep.rejectedOrders }));
            stopPolling();
            setBusy(false);
          }
        }
      } catch {
        /* keep polling briefly */
      }
    }, 750);
  }

  async function loadValidate() {
    if (universeMode === 'ARGUS_DISCOVERY') return; // no fixed symbol list to preview in this mode
    setBusy(true);
    setError(null);
    try {
      const symbols = form.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const results = [];
      for (const symbol of symbols) {
        const res = await fetch('/api/v2/research/datasets/download', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: form.dataProvider,
            symbol,
            frequency: form.frequency,
            startDate: form.startDate,
            endDate: form.endDate,
          }),
        });
        const r = await res.json().catch(() => ({}));
        if (res.status === 429 || r.code === 'REPLAY_LAB_RATE_LIMIT') {
          setError(r.error || 'Historical replay rate limit exceeded. Wait a few minutes, then retry.');
          setBusy(false);
          return;
        }
        results.push(r);
      }
      const red = results.find((r) => r.quality?.quality === 'RED' || r.ok === false);
      if (red && red.ok === false) setError(red.error || red.code || 'DATA_UNAVAILABLE');
      else setRun({
        status: 'DATA_LOADED',
        quality: results[0]?.quality,
        datasetPreview: results,
        live: 'NO-GO',
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function createAndStart(asyncMode = true) {
    setBusy(true);
    setError(null);
    setRun(null);
    setTrades([]);
    setEvents([]);
    setEquity([]);
    try {
      const { symbols: _formSymbols, ...formWithoutSymbols } = form;
      const createRes = await fetch('/api/v2/research/replay/create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(universeMode === 'ARGUS_DISCOVERY' ? formWithoutSymbols : form),
          universeSource: universeMode,
          ...(universeMode === 'OPERATOR_SELECTED'
            ? { symbols: form.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) }
            : {}),
          strategyIds: form.strategyIds.split(',').map((s) => s.trim()).filter(Boolean),
          initialCapital: Number(form.initialCapital),
          allocationBudget: Number(form.allocationBudget),
          maxPositionSize: Number(form.allocationBudget),
          randomSeed: 1,
        }),
      });
      const created = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        const retry = createRes.headers.get('Retry-After');
        const rateLimited = createRes.status === 429 || created.code === 'REPLAY_LAB_RATE_LIMIT';
        setError(
          rateLimited
            ? `${created.error || 'Historical replay rate limit exceeded.'}${retry ? ` Retry-After ${retry}s.` : ' Wait ~1–5 minutes, then retry.'}`
            : (created.error || `create HTTP ${createRes.status}`),
        );
        setRun(created);
        setBusy(false);
        return;
      }
      if (!created.ok && created.status === 'DATA_UNAVAILABLE') {
        setError(created.error || created.code);
        setRun(created);
        setBusy(false);
        return;
      }
      if (created.error && created.status === 'FAILED') {
        setError(created.error);
        setRun(created);
        setBusy(false);
        return;
      }
      setRun(created);
      const startRes = await fetch(`/api/v2/research/replay/${created.replayId}/start?async=${asyncMode ? '1' : '0'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ async: asyncMode }),
      });
      const started = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        setError(started.error || `start HTTP ${startRes.status}`);
        setBusy(false);
        return;
      }
      if (started.error && started.ok === false) {
        setError(started.error);
        setBusy(false);
        return;
      }
      if (asyncMode) {
        startPolling(created.replayId);
        await refreshRun(created.replayId);
      } else {
        setRun(started);
        setTrades(started.trades || []);
        setEvents(started.events || []);
        setEquity(started.equity || []);
        setBusy(false);
      }
      if (started.error) setError(started.error);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  const report = run?.report;
  const rejectedOrders = run?.rejectedOrders || [];
  const noTrade = report?.noTrade || {};
  const qualityLabel = run?.quality?.quality
    ? `DATA QUALITY: ${run.quality.quality}${run.quality.quality === 'RED' ? ' — REPLAY BLOCKED' : ''}`
    : 'DATA QUALITY: NOT RUN';

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6" id="historical-replay-lab">
      <style>{REPLAY_ANIM_STYLE}</style>
      <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
        <History size={18} className="text-amber-400" />
        Argus Historical Evaluation
      </h2>
      <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">
        HISTORICAL EVALUATION · HISTORICAL REPLAY · SIMULATION ONLY · NOT LIVE · NOT PAPER · NOT ORGANIC_PAPER
      </p>
      <p className="text-xs text-slate-400 mb-4">
        Primary workflow: capital + start/end dates. Default universe is Argus Discovery (no symbols required).
        MODE B runs Quant → consensus vote math → RiskEngine → OMS → HistoricalReplayBroker.
        Execution model NEXT_BAR_OPEN. VectorBT remains MODE A research and cannot place orders.
      </p>

      <div className="border border-indigo-500/30 bg-indigo-500/5 rounded p-3 mb-4 text-[11px] text-indigo-100/90">
        Historical Evaluation does not reconstruct the complete historical market universe. Results are based
        on available point-in-time historical data and the configured discovery universe.
      </div>

      <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 mb-4 text-[11px] text-amber-100/90 space-y-1">
        <div className="flex items-center gap-2 font-bold text-amber-300">
          <AlertTriangle size={14} /> Honesty
        </div>
        <div>AI mode DISABLED does not invent historical LLM votes. UNAVAILABLE agents stay UNAVAILABLE.</div>
        <div>Replay fills never count as organic paper. Promotion stays evidence-derived. LIVE remains NO-GO from this lab.</div>
        <div>ZERO_COST_RESEARCH results are theoretical and not live-readiness evidence.</div>
        <div>SURVIVORSHIP_BIAS_WARNING if the universe is operator-selected (not a historical constituent list).</div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-[9px] font-mono text-slate-500 uppercase">Universe</span>
        <button
          type="button"
          onClick={() => setUniverseMode('ARGUS_DISCOVERY')}
          className={`px-2 py-1 text-[10px] font-mono rounded border ${universeMode === 'ARGUS_DISCOVERY' ? 'border-indigo-500 text-indigo-300' : 'border-slate-700 text-slate-400'}`}
        >
          Argus Discovery
        </button>
        <button
          type="button"
          onClick={() => setUniverseMode('OPERATOR_SELECTED')}
          className={`px-2 py-1 text-[10px] font-mono rounded border ${universeMode === 'OPERATOR_SELECTED' ? 'border-amber-500 text-amber-300' : 'border-slate-700 text-slate-400'}`}
        >
          Developer / Diagnostic Mode
        </button>
      </div>
      {universeMode === 'OPERATOR_SELECTED' && (
        <div className="mb-3 text-[10px] font-mono text-amber-300 border border-amber-500/40 bg-amber-500/5 rounded px-2 py-1.5">
          DEVELOPER / DIAGNOSTIC MODE — fixed operator-typed symbol universe, for debugging a specific
          name in isolation. This is not equivalent to an autonomous Argus evaluation; use "Argus
          Discovery" for that.
        </div>
      )}
      {universeMode === 'ARGUS_DISCOVERY' && (
        <div className="mb-3 text-[10px] font-mono text-slate-400 border border-slate-700 bg-slate-900/40 rounded px-2 py-1.5">
          No symbols needed. Argus screens a curated liquid-symbol pool by point-in-time dollar volume
          (bars strictly before each historical timestamp) and trades whichever names qualify at each
          moment — see "Discovered symbols" in the results for what it found and when. This pool is a
          static, curated proxy list, not a reconstructed historical market listing — it carries the
          same survivorship bias as today's index membership.
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-[9px] font-mono text-slate-500 uppercase"><FieldLabel text="Initial capital" tip={FIELD_TIPS.initialCapital} /></span>
        {CAPITAL_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setForm({ ...form, initialCapital: String(c) })}
            className={`px-2 py-1 text-[10px] font-mono rounded border ${Number(form.initialCapital) === c ? 'border-indigo-500 text-indigo-300' : 'border-slate-700 text-slate-400'}`}
          >
            ${c.toLocaleString()}
          </button>
        ))}
        <label className="text-[9px] font-mono text-slate-500 uppercase">
          Custom
          <input
            className="ml-2 w-24 bg-[#0A0F16] border border-slate-700 rounded px-2 py-1 text-xs text-white"
            value={form.initialCapital}
            onChange={(e) => setForm({ ...form, initialCapital: e.target.value })}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        {(['startDate', 'endDate', 'startTime', 'endTime', 'market', 'exchange', 'timezone', 'symbols', 'frequency', 'dataProvider', 'allocationBudget', 'costProfile', 'aiMode', 'strategyIds', 'speed'] as const)
          .filter((key) => key !== 'symbols' || universeMode === 'OPERATOR_SELECTED')
          .map((key) => {
            const selectClass = 'mt-1 w-full bg-[#0A0F16] border border-slate-700 rounded px-2 py-1.5 text-xs text-white';
            const inputClass = selectClass;
            let field: React.ReactNode;
            switch (key) {
              case 'startDate':
              case 'endDate':
                field = (
                  <input
                    type="date"
                    className={inputClass}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                );
                break;
              case 'startTime':
              case 'endTime':
                field = (
                  <input
                    type="time"
                    step={1}
                    className={inputClass}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                );
                break;
              case 'market':
                field = (
                  <select className={selectClass} value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value })}>
                    {MARKET_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                );
                break;
              case 'exchange':
                field = (
                  <select className={selectClass} value={form.exchange} onChange={(e) => setForm({ ...form, exchange: e.target.value })}>
                    {EXCHANGE_OPTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                );
                break;
              case 'timezone':
                field = (
                  <select className={selectClass} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                    {TIMEZONE_OPTIONS.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                );
                break;
              case 'frequency':
                field = (
                  <select className={selectClass} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                    {FREQUENCY_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                );
                break;
              case 'dataProvider':
                field = (
                  <select className={selectClass} value={form.dataProvider} onChange={(e) => setForm({ ...form, dataProvider: e.target.value })}>
                    {DATA_PROVIDER_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                );
                break;
              case 'allocationBudget':
                field = (
                  <input
                    type="number"
                    className={inputClass}
                    value={form.allocationBudget}
                    onChange={(e) => setForm({ ...form, allocationBudget: e.target.value })}
                  />
                );
                break;
              case 'costProfile':
                field = (
                  <select className={selectClass} value={form.costProfile} onChange={(e) => setForm({ ...form, costProfile: e.target.value })}>
                    {['Base', 'REALISTIC_COST', 'Conservative', 'Optimistic', 'ZERO_COST_RESEARCH', 'CUSTOM_COST'].map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                );
                break;
              case 'aiMode':
                field = (
                  <select className={selectClass} value={form.aiMode} onChange={(e) => setForm({ ...form, aiMode: e.target.value })}>
                    {AI_MODE_OPTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                );
                break;
              case 'strategyIds':
                field = (
                  <select
                    className={selectClass}
                    value={form.strategyIds === CORE_STRATEGY_CSV ? 'ALL_CORE' : form.strategyIds}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm({ ...form, strategyIds: v === 'ALL_CORE' ? CORE_STRATEGY_CSV : v });
                    }}
                  >
                    {STRATEGY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                );
                break;
              case 'speed':
                field = (
                  <select className={selectClass} value={form.speed} onChange={(e) => setForm({ ...form, speed: e.target.value })}>
                    {SPEED_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                );
                break;
              default:
                field = (
                  <input
                    className={inputClass}
                    value={(form as any)[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                );
            }
            return (
              <label key={key} className="text-[9px] font-mono text-slate-500 uppercase tracking-widest">
                <FieldLabel text={key} tip={FIELD_TIPS[key]} />
                {field}
              </label>
            );
          })}
      </div>
      <div className="flex gap-4 text-[10px] font-mono text-slate-400 mb-3">
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.shortSelling} onChange={(e) => setForm({ ...form, shortSelling: e.target.checked })} /> <FieldLabel text="Short selling" tip={FIELD_TIPS.shortSelling} /></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.fractionalShares} onChange={(e) => setForm({ ...form, fractionalShares: e.target.checked })} /> <FieldLabel text="Fractional" tip={FIELD_TIPS.fractionalShares} /></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.extendedHours} onChange={(e) => setForm({ ...form, extendedHours: e.target.checked })} /> <FieldLabel text="Extended hours" tip={FIELD_TIPS.extendedHours} /></label>
      </div>
      {(form.costProfile === 'Optimistic' || form.costProfile === 'ZERO_COST_RESEARCH') && (
        <div className="mb-3 text-[10px] font-mono text-amber-300 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">
          WARNING: {form.costProfile} is theoretical / near-zero cost — not live-readiness evidence. Prefer Base or REALISTIC_COST.
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          disabled={busy || universeMode === 'ARGUS_DISCOVERY'}
          onClick={loadValidate}
          title={universeMode === 'ARGUS_DISCOVERY' ? 'No fixed symbol list to preview in Argus Discovery mode' : undefined}
          className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest bg-slate-800 text-slate-200 rounded disabled:opacity-40"
        >
          Load / Validate data
        </button>
        <button type="button" disabled={busy} onClick={() => createAndStart(true)} className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest bg-indigo-600/80 hover:bg-indigo-500 text-white rounded disabled:opacity-40 flex items-center gap-1">
          <Play size={12} /> {busy ? 'Running…' : 'Run historical replay'}
        </button>
        {run?.replayId && (
          <>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/pause`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Pause size={12} /> Pause</button>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/resume`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded">Resume</button>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/step`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><StepForward size={12} /> Step</button>
            <button type="button" onClick={() => fetch(`/api/v2/research/replay/${run.replayId}/stop`, { method: 'POST' })} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Square size={12} /> Stop</button>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=json`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> JSON</a>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=jsonl`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> JSONL</a>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=csv&kind=trades`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> CSV</a>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=markdown`} className="px-3 py-2 text-[10px] font-mono uppercase bg-slate-800 text-slate-200 rounded flex items-center gap-1"><Download size={12} /> Report (MD)</a>
            <a href={`/api/v2/research/replay/${run.replayId}/export?format=zip`} className="px-3 py-2 text-[10px] font-mono uppercase bg-indigo-700 text-white rounded flex items-center gap-1"><Download size={12} /> Export All (ZIP)</a>
          </>
        )}
      </div>

      <div className="text-[10px] font-mono text-slate-400 mb-3">{qualityLabel}</div>

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Data providers</h3>
      <div className="overflow-x-auto mb-4">
        <table className="w-full text-[10px] font-mono text-slate-300">
          <thead className="text-slate-500"><tr><th className="text-left">Id</th><th className="text-left">Availability</th><th className="text-left">Auth</th><th className="text-left">Note</th></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} className="border-t border-slate-800">
                <td className="py-1">{p.id}</td>
                <td>{p.availability}</td>
                <td>{p.authenticationStatus}</td>
                <td className="text-slate-500">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <div className="text-xs text-rose-400 mb-3">{error}</div>}

      {run && (
        <div className="mb-3">
          <div className="mb-2"><StatusBadge status={run.status} /></div>
          <ReplayProgressBar run={run} timezone={form.timezone} />
        </div>
      )}

      {run && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono text-slate-400 mb-3">
          <div>Status {run.status || 'NOT RUN'}</div>
          <div>Quality {run.quality?.quality || 'n/a'}</div>
          <div>ReplayHash {String(run.replayHash || run.hashes?.replayHash || '').slice(0, 18) || '—'}</div>
          <div>Promotion {run.promotion?.status || 'UNTESTED'}</div>
          <div>AI {run.ai?.mode || run.aiLabel || form.aiMode}</div>
          <div>Exec {run.executionModel || report?.executionModel || 'NEXT_BAR_OPEN'}</div>
          <div>Initial {report?.startingCapital ?? form.initialCapital}</div>
          <div>Final {report?.endingCapital != null ? report.endingCapital : '—'}</div>
          <div>Net {report?.netPnl != null ? report.netPnl : '—'}</div>
          <div>Return% {report?.netReturnPct != null ? Number(report.netReturnPct).toFixed(3) : '—'}</div>
          <div>Sharpe {report?.sharpe?.status || '—'}</div>
          <div>Sortino {report?.sortino?.status || '—'}</div>
          <div>Exposure {report?.exposure?.value ?? report?.exposure?.status ?? '—'}</div>
          <div>Turnover {report?.turnover?.value ?? report?.turnover?.status ?? '—'}</div>
        </div>
      )}

      {report?.zeroCostWarning && (
        <div className="mb-3 text-[10px] text-amber-300 font-mono">{report.zeroCostWarning}</div>
      )}

      {report?.honesty && (
        <ul className="text-[10px] text-slate-500 list-disc pl-4 space-y-1 mb-3">
          {report.honesty.map((h: string, i: number) => <li key={i}>{h}</li>)}
        </ul>
      )}

      {report && (
        <div className="mb-4">
          <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Performance &amp; metrics breakdown</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard
              label="Net P&L / Return"
              tone={report.netPnl > 0 ? 'good' : report.netPnl < 0 ? 'bad' : 'neutral'}
              value={`${report.netPnl >= 0 ? '+' : ''}$${Number(report.netPnl).toFixed(2)}`}
              sub={`${report.netReturnPct >= 0 ? '+' : ''}${Number(report.netReturnPct).toFixed(2)}%`}
              tip="Ending equity minus starting capital. Green/red is this run's sign only - not a claim of future performance."
            />
            <MetricCard
              label="Sharpe"
              value={report.sharpe?.status === 'OK' ? Number(report.sharpe.value).toFixed(3) : report.sharpe?.status || '—'}
              sub={report.sharpe?.status === 'OK' ? ratioQualityLabel(report.sharpe.value) : `Needs more closed trades (${report.sharpe?.sampleSize ?? 0} so far)`}
              tip="Withheld below replaySafety.json's minSharpeTrades floor - INSUFFICIENT_SAMPLE is not a bad score, it means too few closed trades to trust the ratio."
            />
            <MetricCard
              label="Sortino"
              value={report.sortino?.status === 'OK' ? Number(report.sortino.value).toFixed(3) : report.sortino?.status || '—'}
              sub={report.sortino?.status === 'OK' ? ratioQualityLabel(report.sortino.value) : (report.sortino?.reason || `Needs more closed trades (${report.sortino?.sampleSize ?? 0} so far)`)}
              tip="Same idea as Sharpe but only penalizes downside volatility. Withheld below replaySafety.json's minSortinoTrades floor."
            />
            <MetricCard
              label="Max Drawdown"
              tone={Math.abs(report.maxDrawdownPct ?? 0) >= 15 ? 'bad' : 'neutral'}
              value={`-${Math.abs(report.maxDrawdownPct ?? 0).toFixed(2)}%`}
              sub={`${drawdownRiskLabel(Math.abs(report.maxDrawdownPct ?? 0))} (UI heuristic, not the RiskEngine portfolio_drawdown gate)`}
              tip="Peak-to-trough decline in this run's equity curve. Low/Moderate/High buckets are a UI-only read (<5% / 5-15% / >15%), not tradingSafety.json's maxPortfolioDrawdownPct risk gate."
            />
            <MetricCard
              label="Win Rate"
              value={report.winRate != null ? `${(report.winRate * 100).toFixed(1)}%` : '—'}
              sub={`${report.totalTrades} trade${report.totalTrades === 1 ? '' : 's'}`}
              tip="Share of closed trades with positive realized P&L, out of all closed trades this run."
            />
            <MetricCard
              label="Profit Factor"
              value={report.profitFactor != null ? Number(report.profitFactor).toFixed(2) : '—'}
              sub="Gross win / gross loss"
              tip="Sum of winning trade P&L divided by the absolute sum of losing trade P&L. Above 1.0 means gross wins exceeded gross losses this run."
            />
            <MetricCard
              label="Avg Win / Avg Loss"
              value={`${report.averageWin != null ? '$' + Number(report.averageWin).toFixed(2) : '—'} / ${report.averageLoss != null ? '$' + Number(report.averageLoss).toFixed(2) : '—'}`}
              sub="Mean realized P&L per winning/losing trade"
            />
            <MetricCard
              label="Turnover"
              value={report.turnover?.value ?? report.turnover?.status ?? '—'}
              sub="Sum |trade notional| / starting capital"
            />
          </div>
        </div>
      )}

      {report && (
        <div className="mb-4 border border-slate-800 bg-[#0b101b] rounded p-3">
          <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Executive strategy summary</h3>
          <div className="text-xs text-slate-300 leading-relaxed space-y-1">
            {buildExecutiveSummary(report, noTrade, form.strategyIds).map((line, i) => <p key={i}>{line}</p>)}
          </div>
        </div>
      )}

      {run?.config?.symbols && (
        <div className="mb-3 text-[10px] font-mono">
          <span className="ml-0 text-slate-500 uppercase">Universe source: </span>
          <span className="text-amber-400">{run.universeSource || 'OPERATOR_SELECTED'}</span>
          {run.universeSource === 'ARGUS_DISCOVERY' ? (
            <>
              <span className="ml-3 text-slate-500 uppercase">Candidate pool: </span>
              <span className="text-slate-400">{run.config.symbols.length} symbols (static, curated)</span>
              {Array.isArray(run.discoveredSymbols) && (
                <>
                  <div className="mt-1 text-slate-500 uppercase">Discovered symbols:</div>
                  <div className="text-slate-300">
                    {run.discoveredSymbols.length === 0
                      ? 'None discovered this run.'
                      : run.discoveredSymbols.map((d: any) => d.symbol).join(', ')}
                  </div>
                </>
              )}
              <div className="text-slate-600 mt-0.5">Argus screened the candidate pool by point-in-time liquidity and traded only the names that qualified at each historical moment — nothing here was typed in.</div>
            </>
          ) : (
            <>
              <span className="text-slate-300 ml-1">{run.config.symbols.join(', ')}</span>
              <span className="ml-3 text-slate-500 uppercase">Discovery: </span>
              <span className="text-amber-400">NOT_ACTIVE_IN_REPLAY</span>
              <div className="text-slate-600 mt-0.5">These are the symbols you configured for this run, not symbols Argus discovered historically.</div>
            </>
          )}
        </div>
      )}

      {(run?.consensusMode || run?.historicalEvaluation) && (
        <div className="mb-4 text-[10px] font-mono text-slate-400 border border-slate-800 rounded p-2 space-y-1">
          <div className="text-slate-500 uppercase">Evaluation metadata</div>
          {run.consensusMode && <div>Consensus: <span className="text-amber-300">{run.consensusMode}</span></div>}
          {run.consensusModeDescription && <div className="text-slate-500">{run.consensusModeDescription}</div>}
          {run.partialFillModel && <div>Fill model: {run.partialFillModel} / {run.executionModel || 'NEXT_BAR_OPEN'}</div>}
          {run.historicalEvaluation?.historicalFidelity && (
            <div>HISTORICAL FIDELITY: <span className="text-amber-400">{run.historicalEvaluation.historicalFidelity}</span></div>
          )}
          {run.historicalEvaluation?.disclaimer && <div className="text-slate-500">{run.historicalEvaluation.disclaimer}</div>}
        </div>
      )}

      {run?.agentAvailability && (
        <div className="mb-4">
          <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Agent availability</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-[10px] font-mono text-slate-400">
            {Object.entries(run.agentAvailability).map(([k, v]: any) => (
              <div key={k}>{k}: {v.status} — {v.reason}</div>
            ))}
          </div>
        </div>
      )}

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Trades</h3>
      <div className="overflow-x-auto mb-4 max-h-48 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="text-[10px] text-slate-500 space-y-1">
            <div>NO FILLS — P&amp;L stays 0 until a BUY clears RiskEngine/OMS.</div>
            {Object.keys(noTrade).length > 0 && (
              <div className="text-amber-400/90">NO_TRADE counts: {JSON.stringify(noTrade)}</div>
            )}
          </div>
        ) : (
          <table className="w-full text-[10px] font-mono text-slate-300">
            <thead className="text-slate-500 sticky top-0 bg-[#1A1F2B]">
              <tr>
                <th className="text-left">Time</th>
                <th className="text-left">Symbol</th>
                <th className="text-left">Action</th>
                <th className="text-left">Qty</th>
                <th className="text-left">Price</th>
                <th className="text-left">Strategy</th>
                <th className="text-left">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={t.traceId || i} className={`border-t border-slate-800 ${i === trades.length - 1 ? 'replay-row-fade-in' : ''}`}>
                  <td className="py-1">{formatReplayTimestamp(t.timestamp, form.timezone)}</td>
                  <td>{t.symbol}</td>
                  <td>{t.side}</td>
                  <td>{t.quantity}</td>
                  <td>{t.price}</td>
                  <td>{t.strategyId}</td>
                  <td>{t.realizedPnl ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rejectedOrders.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-mono uppercase text-amber-500/80 mb-2">Rejected orders (why no P&amp;L)</h3>
          <ul className="text-[10px] font-mono text-slate-400 space-y-1">
            {rejectedOrders.map((r: any, i: number) => (
              <li key={r.traceId || i}>{r.symbol} {r.side}: {r.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Equity curve ({equity.length || 0} pts)</h3>
      <div className="mb-4 border border-slate-800 bg-[#0b101b] rounded p-2">
        <EquityChart equity={equity} timezone={form.timezone} isRunning={run?.status === 'RUNNING'} />
      </div>

      <h3 className="text-[10px] font-mono uppercase text-slate-500 mb-2">Event timeline (tail)</h3>
      <div className="overflow-x-auto max-h-40 overflow-y-auto mb-3">
        {events.length === 0 ? (
          <div className="text-[10px] text-slate-500">NO DATA</div>
        ) : (
          <ul className="text-[10px] font-mono text-slate-400 space-y-0.5">
            {events.map((e, i) => (
              <li key={e.eventId || i} className={i === events.length - 1 ? 'replay-row-fade-in' : ''}>[{formatReplayTimestamp(e.historicalTimestamp, form.timezone)}] {e.type} {e.symbol || ''} {e.payload?.side || e.payload?.reason || ''}</li>
            ))}
          </ul>
        )}
      </div>

      {Object.keys(noTrade).length > 0 && trades.length > 0 && (
        <div className="mt-3 text-[10px] font-mono text-slate-400">
          NO_TRADE counts: {JSON.stringify(noTrade)}
        </div>
      )}
    </div>
  );
}
