import React from 'react';
import { BookOpen, Play } from 'lucide-react';
import { ResponsiveDataCards, type DataColumn } from './ResponsiveDataCards';

export type TradeHistoryRow = {
  date: string;
  symbol: string;
  decision: string;
  weight: string | number;
  outcome: string;
  outcomeClass: string;
  index: number;
  onReplay: () => void;
  onJournal: () => void;
  journalLabel: string;
};

const columns: DataColumn<TradeHistoryRow>[] = [
  { key: 'symbol', header: 'Symbol', primary: true, render: (t) => <span className="font-bold text-white">{t.symbol}</span> },
  {
    key: 'decision',
    header: 'Decision',
    primary: true,
    render: (t) => (
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.decision === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : t.decision === 'SELL' ? 'bg-amber-500/20 text-amber-500' : 'bg-slate-800 text-slate-400'}`}>
        {t.decision}
      </span>
    ),
  },
  { key: 'date', header: 'Date', render: (t) => <span className="text-slate-400">{t.date}</span> },
  { key: 'weight', header: 'Sizing Weight', render: (t) => `${t.weight}x` },
  { key: 'outcome', header: 'P&L Outcome', render: (t) => <span className={`font-bold ${t.outcomeClass}`}>{t.outcome}</span> },
  {
    key: 'actions',
    header: 'Action',
    render: (t) => (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={t.onReplay}
          className="argus-touch-target text-[10px] font-mono uppercase tracking-widest text-sky-400 hover:text-sky-300 border border-sky-500/30 rounded px-2 py-1 bg-sky-500/10 flex items-center gap-1.5"
        >
          <Play size={10} /> Replay
        </button>
        <button
          type="button"
          onClick={t.onJournal}
          className="argus-touch-target text-[10px] font-mono uppercase tracking-widest text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 rounded px-2 py-1 bg-indigo-500/10 flex items-center gap-1.5"
        >
          <BookOpen size={10} /> {t.journalLabel}
        </button>
      </div>
    ),
  },
];

type TradeHistoryDataViewProps = {
  rows: TradeHistoryRow[];
};

export function TradeHistoryDataView({ rows }: TradeHistoryDataViewProps) {
  return (
    <ResponsiveDataCards
      columns={columns}
      rows={rows}
      rowKey={(t) => `${t.symbol}-${t.date}-${t.index}`}
      emptyMessage="No historical trades recorded."
    />
  );
}
