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

interface MissionControlData {
  marketData: { connected: boolean };
  agents: { active: number; total: number };
  aiModels: { healthy: number; total: number };
  broker: { name: string; capabilities: any };
  riskEngine: { armed: boolean };
  autobot: { running: boolean };
  tradesToday: number;
  winRate: number | null;
  realizedPnlToday: number | null;
  aiCostToday: number;
  eventsPerSec: number;
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: 'good' | 'bad' | 'neutral' }) {
  const toneClass = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-white';
  return (
    <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col gap-1 min-w-[110px]">
      <div className="flex items-center gap-1.5 text-slate-500">{icon}<span className="text-[9px] uppercase tracking-widest font-bold">{label}</span></div>
      <span className={`text-sm font-bold font-mono ${toneClass}`}>{value}</span>
    </div>
  );
}

export default function MissionControlBar() {
  const [data, setData] = useState<MissionControlData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/v2/system/mission-control')
        .then(r => r.json())
        .then(json => { if (!cancelled && json.ok) setData(json); })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (!data) {
    return <div className="text-[10px] text-slate-600 font-mono uppercase tracking-widest px-2 py-3">Loading mission control...</div>;
  }

  return (
    <div className="flex flex-wrap gap-3">
      <StatCard
        icon={<Activity size={12} />} label="Market Data"
        value={data.marketData.connected ? '● CONNECTED' : '○ DISCONNECTED'}
        tone={data.marketData.connected ? 'good' : 'bad'}
      />
      <StatCard
        icon={<Bot size={12} />} label="Agents"
        value={`${data.agents.active} / ${data.agents.total} ACTIVE`}
        tone={data.agents.active === data.agents.total ? 'good' : data.agents.active === 0 ? 'bad' : 'neutral'}
      />
      <StatCard
        icon={<Cpu size={12} />} label="AI Models"
        value={`${data.aiModels.healthy} / ${data.aiModels.total} HEALTHY`}
        tone={data.aiModels.total === 0 ? 'neutral' : data.aiModels.healthy === data.aiModels.total ? 'good' : 'bad'}
      />
      <StatCard
        icon={<Zap size={12} />} label="Broker" value={data.broker.name}
        tone={data.broker.name === 'None' ? 'bad' : 'good'}
      />
      <StatCard
        icon={<ShieldCheck size={12} />} label="Risk Engine"
        value={data.riskEngine.armed ? '● ARMED' : '○ HALTED'}
        tone={data.riskEngine.armed ? 'good' : 'bad'}
      />
      <StatCard
        icon={<Bot size={12} />} label="AutoBot"
        value={data.autobot.running ? '● RUNNING' : '○ STOPPED'}
        tone={data.autobot.running ? 'good' : 'neutral'}
      />
      <StatCard icon={<TrendingUp size={12} />} label="Trades Today" value={data.tradesToday} />
      <StatCard
        icon={<TrendingUp size={12} />} label="Win Rate"
        value={data.winRate !== null ? `${(data.winRate * 100).toFixed(1)}%` : 'DATA UNAVAILABLE'}
        tone={data.winRate === null ? 'neutral' : undefined}
      />
      <StatCard
        icon={<DollarSign size={12} />} label="Realized P&L"
        value={data.realizedPnlToday !== null ? `${data.realizedPnlToday >= 0 ? '+' : ''}$${data.realizedPnlToday.toFixed(2)}` : 'DATA UNAVAILABLE'}
        tone={data.realizedPnlToday === null ? 'neutral' : data.realizedPnlToday >= 0 ? 'good' : 'bad'}
      />
      <StatCard icon={<DollarSign size={12} />} label="AI Cost Today" value={`$${data.aiCostToday.toFixed(4)}`} />
      <StatCard icon={<Zap size={12} />} label="Events / Sec" value={data.eventsPerSec} />
    </div>
  );
}
