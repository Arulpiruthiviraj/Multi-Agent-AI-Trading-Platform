import React from 'react';
import { UnavailableHint } from '../UnavailableHint';
import { ResponsiveDataCards, type DataColumn } from './ResponsiveDataCards';

export type PositionRow = {
  symbol: string;
  sector?: string;
  quantity: number;
  entryPrice: number;
  livePrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  isPositive: boolean;
};

type PositionsDataViewProps = {
  positions: PositionRow[];
  cashBalance?: number;
  emptyMessage?: React.ReactNode;
};

const columns: DataColumn<PositionRow>[] = [
  {
    key: 'symbol',
    header: 'Ticker',
    primary: true,
    render: (p) => (
      <span className="font-bold text-white tracking-wider flex items-center gap-2">
        {p.symbol}
        <span className={`h-1.5 w-1.5 rounded-full ${p.isPositive ? 'bg-emerald-400' : 'bg-rose-400'}`} />
      </span>
    ),
  },
  {
    key: 'pnl',
    header: 'Unrealized P&L',
    primary: true,
    cellClassName: 'text-right',
    render: (p) => (
      <span className={`font-semibold ${p.isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
        {p.isPositive ? '+' : ''}${p.unrealizedPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        {' '}({p.isPositive ? '+' : ''}{p.unrealizedPnlPercent.toFixed(2)}%)
      </span>
    ),
  },
  { key: 'sector', header: 'Sector', render: (p) => p.sector || <UnavailableHint reason="No GICS/sector field on this broker position row.">--</UnavailableHint> },
  { key: 'shares', header: 'Shares', render: (p) => p.quantity },
  { key: 'entry', header: 'Entry Price', render: (p) => `$${p.entryPrice.toFixed(2)}` },
  { key: 'live', header: 'Live Price', render: (p) => `$${p.livePrice.toFixed(2)}` },
  {
    key: 'stop',
    header: 'Stop-Loss',
    render: () => <UnavailableHint reason="No resting broker stop is stored on positions. PortfolioMonitor emits SELL ideas from settings.takeProfitPct / trailingStopPct through RiskEngine — this column is not a live stop price.">--</UnavailableHint>,
  },
  {
    key: 'tp',
    header: 'Take-Profit',
    render: () => <UnavailableHint reason="No resting take-profit order is stored on positions. Monitor targets come from settings.takeProfitPct when Autobot is started.">--</UnavailableHint>,
  },
  { key: 'mv', header: 'Market Value', render: (p) => `$${p.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
];

export function PositionsDataView({ positions, cashBalance, emptyMessage }: PositionsDataViewProps) {
  return (
    <div id="positions-table-box">
      <ResponsiveDataCards
        tableId="positions-table"
        columns={columns}
        rows={positions}
        rowKey={(p) => p.symbol}
        emptyMessage={emptyMessage}
      />
      {cashBalance !== undefined && positions.length > 0 && (
        <>
          <div className="hidden xl:flex mt-0 bg-[#111822]/30 font-bold border border-t-0 border-slate-800 rounded-b-lg text-xs font-mono px-4 py-3 justify-between">
            <span className="text-slate-400">CASH · Liquidity Reservoir</span>
            <span className="text-slate-200">${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div className="mt-3 p-3 rounded-lg border border-slate-800 bg-[#111822]/30 flex justify-between text-xs font-mono xl:hidden">
            <span className="text-slate-400 font-bold">CASH · Liquidity Reservoir</span>
            <span className="text-slate-200">${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </>
      )}
    </div>
  );
}
