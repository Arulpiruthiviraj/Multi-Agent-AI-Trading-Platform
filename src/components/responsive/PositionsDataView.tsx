import React from 'react';
import { UnavailableHint } from '../UnavailableHint';
import { ResponsiveDataCards, type DataColumn } from './ResponsiveDataCards';

export type PositionRow = {
  symbol: string;
  sector?: string;
  quantity: number;
  entryPrice: number;
  // Real bug fix (2026-08-18): these three used to be plain `number` and could genuinely be NaN
  // (e.g. a broker position with no real cost-basis populated - the EXTERNAL_SYNC baseline-import
  // rows in this exact environment are a live example) - `NaN.toLocaleString()`/`.toFixed()` both
  // render the literal string "NaN", which looked like a real $0-ish P&L rather than what it
  // actually was: unavailable data. Callers now pass null when the inputs aren't real finite
  // numbers, and this renders an honest UnavailableHint instead.
  livePrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  isPositive: boolean;
  // Real stop-loss/take-profit price for this position (server: resolvePositionStopTarget) -
  // a QuantEngine position's own stored quantStopPrice/quantTargetPrice when present, else
  // averagePrice adjusted by settings.trailingStopPct/takeProfitPct. Null only if the server
  // could not resolve one (e.g. a transient DB error) - never a fabricated number.
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
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
      !Number.isFinite(p.unrealizedPnl) || !Number.isFinite(p.unrealizedPnlPercent) ? (
        <UnavailableHint reason="No real cost basis and/or live price for this position yet - P&L is not computed from a fabricated $0.">--</UnavailableHint>
      ) : (
        <span className={`font-semibold ${p.isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
          {p.isPositive ? '+' : ''}${p.unrealizedPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          {' '}({p.isPositive ? '+' : ''}{(p.unrealizedPnlPercent as number).toFixed(2)}%)
        </span>
      )
    ),
  },
  { key: 'sector', header: 'Sector', render: (p) => p.sector || <UnavailableHint reason="No GICS/sector field on this broker position row.">--</UnavailableHint> },
  { key: 'shares', header: 'Shares', render: (p) => Number.isFinite(p.quantity) ? p.quantity : <UnavailableHint reason="No share quantity on this broker position row.">--</UnavailableHint> },
  { key: 'entry', header: 'Entry Price', render: (p) => Number.isFinite(p.entryPrice) ? `$${p.entryPrice.toFixed(2)}` : <UnavailableHint reason="No entry price on this broker position row.">--</UnavailableHint> },
  { key: 'live', header: 'Live Price', render: (p) => p.livePrice !== null ? `$${p.livePrice.toFixed(2)}` : <UnavailableHint reason="No live tick received yet for this symbol.">--</UnavailableHint> },
  {
    key: 'stop',
    header: 'Stop-Loss',
    render: (p) => p.stopLossPrice != null
      ? `$${p.stopLossPrice.toFixed(2)}`
      : <UnavailableHint reason="Server could not resolve a stop-loss price for this position (resolvePositionStopTarget) - not a fabricated $0.">--</UnavailableHint>,
  },
  {
    key: 'tp',
    header: 'Take-Profit',
    render: (p) => p.takeProfitPrice != null
      ? `$${p.takeProfitPrice.toFixed(2)}`
      : <UnavailableHint reason="Server could not resolve a take-profit price for this position (resolvePositionStopTarget) - not a fabricated $0.">--</UnavailableHint>,
  },
  { key: 'mv', header: 'Market Value', render: (p) => p.marketValue !== null ? `$${p.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : <UnavailableHint reason="No live price to compute market value yet.">--</UnavailableHint> },
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
            <span className="text-slate-200">{Number.isFinite(cashBalance) ? `$${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</span>
          </div>
          <div className="mt-3 p-3 rounded-lg border border-slate-800 bg-[#111822]/30 flex justify-between text-xs font-mono xl:hidden">
            <span className="text-slate-400 font-bold">CASH · Liquidity Reservoir</span>
            <span className="text-slate-200">{Number.isFinite(cashBalance) ? `$${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</span>
          </div>
        </>
      )}
    </div>
  );
}
