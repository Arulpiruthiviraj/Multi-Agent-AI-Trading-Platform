import React from 'react';
import { UnavailableHint } from '../UnavailableHint';
import { RIBBON_HEALTH_UNAVAILABLE } from '../observatoryHonesty';
import { Explainer } from '../ContextualTooltip';
import { Wallet, Shield, ArrowUpRight } from 'lucide-react';
import { ResponsiveMetricCarousel, type MetricCard } from './ResponsiveMetricCarousel';

export type BrokerRibbonData = {
  equity?: number;
  cash?: number;
  positionsValue?: number;
  unrealized?: number;
  health?: number;
  positionCount?: number;
  unavailableReason?: string;
};

type ResponsiveStatsSectionProps = {
  brokerRibbon: BrokerRibbonData;
};

export function ResponsiveStatsSection({ brokerRibbon }: ResponsiveStatsSectionProps) {
  const metrics: MetricCard[] = [
    {
      id: 'equity',
      label: <Explainer id="totalEquity">Total Equity</Explainer>,
      value: brokerRibbon.equity !== undefined
        ? `$${brokerRibbon.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : <UnavailableHint reason={brokerRibbon.unavailableReason}>--</UnavailableHint>,
      sub: 'Overall P&L Tracking',
      accent: 'emerald',
    },
    {
      id: 'cash',
      label: <Explainer id="cashBalance">Cash Balance</Explainer>,
      value: brokerRibbon.cash !== undefined
        ? `$${brokerRibbon.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : <UnavailableHint reason={brokerRibbon.unavailableReason}>--</UnavailableHint>,
      sub: 'Ready allocation collateral',
      accent: 'neutral',
    },
    {
      id: 'positions',
      label: <Explainer id="positionsValuation">Positions Valuation</Explainer>,
      value: brokerRibbon.positionsValue !== undefined
        ? `$${brokerRibbon.positionsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : <UnavailableHint reason={brokerRibbon.unavailableReason}>--</UnavailableHint>,
      sub: `${brokerRibbon.positionCount !== undefined ? brokerRibbon.positionCount : '--'} active stock allocations`,
      accent: 'neutral',
    },
    {
      id: 'unrealized',
      label: <Explainer id="unrealizedPnl">Unrealized profit/losses</Explainer>,
      value: brokerRibbon.unrealized !== undefined
        ? `${brokerRibbon.unrealized >= 0 ? '+' : ''}$${brokerRibbon.unrealized.toFixed(2)}`
        : <UnavailableHint reason={brokerRibbon.unavailableReason}>--</UnavailableHint>,
      sub: 'Active returns gain indices',
      accent: brokerRibbon.unrealized !== undefined && brokerRibbon.unrealized < 0 ? 'rose' : 'emerald',
    },
    {
      id: 'health',
      label: <Explainer id="portfolioHealthscore">Portfolio Healthscore</Explainer>,
      value: brokerRibbon.health !== undefined
        ? `${brokerRibbon.health.toFixed(1)}/100`
        : <UnavailableHint reason={RIBBON_HEALTH_UNAVAILABLE}>--</UnavailableHint>,
      sub: brokerRibbon.health !== undefined ? 'NOMINAL · Exposure index <35% check' : undefined,
      accent: 'emerald',
      icon: <Shield size={12} className="text-emerald-400" />,
    },
  ];

  return (
    <>
      <ResponsiveMetricCarousel metrics={metrics} />
      <section
        className="argus-desktop-only bg-[#1A1F2B]/40 border-b border-slate-850 px-6 py-5 grid grid-cols-2 md:grid-cols-5 gap-4"
        id="stats-ribbon"
      >
        <div className="p-3 bg-[#1A1F2B]/50 rounded border border-slate-800/60">
          <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1 flex items-center justify-between">
            <span>{metrics[0].label}</span>
            <Wallet size={12} className="text-slate-500" />
          </div>
          <div className="text-lg font-bold text-white">{metrics[0].value}</div>
          <div className="text-[10px] text-emerald-400 font-mono flex items-center gap-0.5 mt-0.5">
            <ArrowUpRight size={10} />
            <span>Overall P&L Tracking</span>
          </div>
        </div>
        <div className="p-3 bg-[#1A1F2B]/50 rounded border border-slate-800/60">
          <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1">{metrics[1].label}</div>
          <div className="text-lg font-semibold text-slate-200">{metrics[1].value}</div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5">Ready allocation collateral</div>
        </div>
        <div className="p-3 bg-[#1A1F2B]/50 rounded border border-slate-800/60">
          <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1">{metrics[2].label}</div>
          <div className="text-lg font-semibold text-slate-200">{metrics[2].value}</div>
          <div className="text-[10px] text-slate-400 font-mono mt-0.5">{metrics[2].sub}</div>
        </div>
        <div className="p-3 bg-[#1A1F2B]/50 rounded border border-slate-800/60">
          <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1">{metrics[3].label}</div>
          <div className={`text-lg font-semibold ${brokerRibbon.unrealized !== undefined && brokerRibbon.unrealized < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
            {metrics[3].value}
          </div>
          <div className={`text-[10px] font-mono mt-0.5 ${brokerRibbon.unrealized !== undefined && brokerRibbon.unrealized < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
            Active returns gain indices
          </div>
        </div>
        <div className="p-3 bg-[#1A1F2B]/50 rounded border border-slate-800/60 col-span-2 md:col-span-1">
          <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1 flex items-center justify-between">
            <span>{metrics[4].label}</span>
            <Shield size={12} className="text-emerald-400" />
          </div>
          <div className="flex items-center gap-2">
            <div className="text-lg font-bold text-white">
              {brokerRibbon.health !== undefined ? brokerRibbon.health.toFixed(1) : metrics[4].value}
              {brokerRibbon.health !== undefined && '/100'}
            </div>
            {brokerRibbon.health !== undefined && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/20 text-emerald-400 font-semibold tracking-wide uppercase font-mono">
                <Explainer id="ribbonNominal" quiet>NOMINAL</Explainer>
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5">Exposure index &lt;35% check</div>
        </div>
      </section>
    </>
  );
}
