/**
 * ==========================================================
 * Module: MissionControlBar
 *
 * Purpose:
 * Real global system-health strip (req #14) - every number comes from
 * GET /api/v2/system/mission-control, which reads real agent recency, real ai_providers.health,
 * real broker capabilities, real trades/ai_calls rows, and a real in-memory event-rate count.
 * An agent/model that hasn't produced a real signal recently is reported inactive, never assumed
 * healthy. Polls every 5s - cheap enough for a summary strip, not a WebSocket subscription.
 * ==========================================================
 */
import React, { useEffect, useState } from 'react';
import { Activity, Cpu, Zap, ShieldCheck, Bot, TrendingUp, DollarSign } from 'lucide-react';
import { UnavailableHint } from './UnavailableHint';
import {
  AGENTS_INACTIVE,
  AI_MODELS_PARTIAL,
  REALIZED_PNL_UNAVAILABLE,
  TRADES_TODAY_HINT,
  WIN_RATE_UNAVAILABLE,
} from './observatoryHonesty';

interface MissionControlData {
  marketData: { connected: boolean };
  agents: { active: number; total: number };
  aiModels: { healthy: number; total: number };
  broker: { name: string; capabilities: any };
  riskEngine: { armed: boolean };
  autobot: {
    running: boolean;
    scheduleEnabled?: boolean;
    inWindow?: boolean | null;
  };
  tradesToday: number;
  winRate: number | null;
  realizedPnlToday: number | null;
  winRateUnavailableReason?: string | null;
  realizedPnlUnavailableReason?: string | null;
  aiCostToday: number;
  eventsPerSec: number;
}

function StatCard({ icon, label, value, tone, title }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: 'good' | 'bad' | 'neutral'; title?: string }) {
  const toneClass = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-white';
  return (
    <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col gap-1 min-w-[110px]" title={title}>
      <div className="flex items-center gap-1.5 text-slate-500">{icon}<span className="text-[9px] uppercase tracking-widest font-bold">{label}</span></div>
      <span className={`text-sm font-bold font-mono ${toneClass}`}>{value}</span>
    </div>
  );
}

export default function MissionControlBar() {
  const [data, setData] = useState<MissionControlData | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      fetch('/api/v2/system/mission-control')
        .then(r => r.json())
        .then(json => { if (!cancelled && json.ok) setData(json); })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (!data) {
    return <div className="text-[10px] text-slate-600 font-mono uppercase tracking-widest px-2 py-3">Loading mission control...</div>;
  }

  const winRateReason = data.winRateUnavailableReason || WIN_RATE_UNAVAILABLE;
  const pnlReason = data.realizedPnlUnavailableReason || REALIZED_PNL_UNAVAILABLE;
  const agentsTitle = data.agents.active === 0 ? AGENTS_INACTIVE : `${data.agents.active} of ${data.agents.total} pipeline agents emitted a prediction in the last ~3 minutes.`;
  const modelsTitle = data.aiModels.healthy < data.aiModels.total || data.aiModels.total === 0 ? AI_MODELS_PARTIAL : `${data.aiModels.healthy} enabled AI providers marked Healthy.`;

  return (
    <div className="flex flex-wrap gap-3">
      <StatCard
        icon={<Activity size={12} />} label="Market Data"
        value={data.marketData.connected ? '● CONNECTED' : '○ DISCONNECTED'}
        tone={data.marketData.connected ? 'good' : 'bad'}
        title={data.marketData.connected
          ? 'MarketDataWorker WebSocket is connected.'
          : 'MarketDataWorker is not connected. Ticks will not flow; data_freshness / live prices may fail closed. Autobot STOPPED also stops the worker.'}
      />
      <StatCard
        icon={<Bot size={12} />} label="Agents"
        value={`${data.agents.active} / ${data.agents.total} ACTIVE`}
        tone={data.agents.active === data.agents.total ? 'good' : data.agents.active === 0 ? 'bad' : 'neutral'}
        title={agentsTitle}
      />
      <StatCard
        icon={<Cpu size={12} />} label="AI Models"
        value={`${data.aiModels.healthy} / ${data.aiModels.total} HEALTHY`}
        tone={data.aiModels.total === 0 ? 'neutral' : data.aiModels.healthy === data.aiModels.total ? 'good' : 'bad'}
        title={modelsTitle}
      />
      <StatCard
        icon={<Zap size={12} />} label="Broker" value={data.broker.name}
        tone={data.broker.name === 'None' ? 'bad' : 'good'}
        title={data.broker.name === 'None'
          ? 'No active broker. GET /api/v1/portfolio will 502 and the equity ribbon stays --.'
          : `Active broker: ${data.broker.name}. Paper Internal Simulator reports in-memory cash (default $100k), not Alpaca equity.`}
      />
      <StatCard
        icon={<ShieldCheck size={12} />} label="Risk Engine"
        value={data.riskEngine.armed ? '● ARMED' : '○ HALTED'}
        tone={data.riskEngine.armed ? 'good' : 'bad'}
        title={data.riskEngine.armed
          ? 'emergency-stop / TRADING_PAUSED is not active. Ideas still need consensus before RiskEngine runs.'
          : 'Kill switch is engaged (emergency-stop / TRADING_PAUSED). New entries are blocked.'}
      />
      <StatCard
        icon={<Bot size={12} />} label="AutoBot"
        value={data.autobot.running
          ? '● RUNNING'
          : data.autobot.scheduleEnabled && data.autobot.inWindow === false
            ? '○ STOPPED · OUTSIDE WINDOW'
            : '○ STOPPED'}
        tone={data.autobot.running ? 'good' : 'neutral'}
        title={data.autobot.running
          ? 'TradingEngine enabled; agent engines are started.'
          : 'Autobot STOPPED: system.stop() idles agent engines. Existing NO_CONSENSUS rows remain on the ledger; no new fills until Autobot is started and consensus + risk pass.'}
      />
      <StatCard
        icon={<TrendingUp size={12} />} label="Trades Today" value={data.tradesToday}
        title={TRADES_TODAY_HINT}
      />
      <StatCard
        icon={<TrendingUp size={12} />} label="Win Rate"
        value={data.winRate !== null
          ? `${(data.winRate * 100).toFixed(1)}%`
          : <UnavailableHint reason={winRateReason}>DATA UNAVAILABLE</UnavailableHint>}
        tone={data.winRate === null ? 'neutral' : undefined}
        title={data.winRate === null ? winRateReason : 'Share of today\'s filled trades with booked P&L that were profitable. Not a calibrated live edge.'}
      />
      <StatCard
        icon={<DollarSign size={12} />} label="Realized P&L"
        value={data.realizedPnlToday !== null
          ? `${data.realizedPnlToday >= 0 ? '+' : ''}$${data.realizedPnlToday.toFixed(2)}`
          : <UnavailableHint reason={pnlReason}>DATA UNAVAILABLE</UnavailableHint>}
        tone={data.realizedPnlToday === null ? 'neutral' : data.realizedPnlToday >= 0 ? 'good' : 'bad'}
        title={data.realizedPnlToday === null ? pnlReason : 'Sum of booked profitLoss on today\'s filled trades.'}
      />
      <StatCard icon={<DollarSign size={12} />} label="AI Cost Today" value={`$${data.aiCostToday.toFixed(4)}`} title="Sum of ai_calls.cost for rows created today. Local/Ollama is $0." />
      <StatCard icon={<Zap size={12} />} label="Events / Sec" value={data.eventsPerSec} title="In-memory EventBus ring count over the last 10 seconds. Not a durable event_traces rate." />
    </div>
  );
}
