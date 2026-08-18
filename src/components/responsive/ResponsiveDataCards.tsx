import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type DataColumn<T> = {
  key: string;
  header: string;
  /** Shown in card header row on mobile */
  primary?: boolean;
  /** Hidden behind accordion on mobile unless primary */
  render: (row: T, index: number) => React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
};

export type ResponsiveDataCardsProps<T> = {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  emptyMessage?: React.ReactNode;
  tableId?: string;
  /** Force card layout below this breakpoint class — default uses CSS .argus-compact-only sibling */
  forceCards?: boolean;
};

export function partitionColumns<T>(columns: DataColumn<T>[]) {
  const primary = columns.filter((c) => c.primary);
  const secondary = columns.filter((c) => !c.primary);
  return {
    primary: primary.length > 0 ? primary : columns.slice(0, 2),
    secondary: primary.length > 0 ? secondary : columns.slice(2),
  };
}

export function ResponsiveDataCards<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'No data',
  tableId,
  forceCards,
}: ResponsiveDataCardsProps<T>) {
  const { primary, secondary } = partitionColumns(columns);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-slate-500 font-mono text-xs">{emptyMessage}</div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className={`overflow-x-auto min-w-full ${forceCards ? 'hidden' : 'hidden xl:block'}`}>
        <table className="w-full text-left border-collapse" id={tableId}>
          <thead>
            <tr className="border-b border-slate-800/80 text-[10px] font-mono text-slate-500 uppercase tracking-widest bg-[#111822]/50">
              {columns.map((col) => (
                <th key={col.key} className={`py-3 px-4 ${col.headerClassName ?? ''}`}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 text-xs font-mono">
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)} className="hover:bg-[#111822]/50 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className={`py-4 px-4 ${col.cellClassName ?? ''}`}>
                    {col.render(row, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile / tablet cards */}
      <div className={`space-y-3 ${forceCards ? 'block' : 'xl:hidden'}`}>
        {rows.map((row, i) => {
          const rk = rowKey(row, i);
          const isOpen = expanded[rk];
          return (
            <article
              key={rk}
              className="rounded-lg border border-slate-800 bg-[#111822]/50 overflow-hidden"
            >
              <div className="p-3 flex flex-wrap items-start justify-between gap-2">
                {primary.map((col) => (
                  <div key={col.key} className="min-w-0">
                    <div className="text-[9px] font-mono uppercase text-slate-500 tracking-wider">{col.header}</div>
                    <div className="text-sm font-mono text-slate-200 mt-0.5">{col.render(row, i)}</div>
                  </div>
                ))}
              </div>
              {secondary.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => toggle(rk)}
                    className="argus-touch-target w-full flex items-center justify-center gap-1 py-2 border-t border-slate-800/80 text-[9px] font-mono uppercase tracking-widest text-slate-500 hover:text-slate-300"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? 'Less' : 'Details'}
                    <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {isOpen && (
                    <dl className="px-3 pb-3 space-y-2 border-t border-slate-800/60 pt-2">
                      {secondary.map((col) => (
                        <div key={col.key} className="flex justify-between gap-3 text-[11px] font-mono">
                          <dt className="text-slate-500 shrink-0">{col.header}</dt>
                          <dd className="text-slate-200 text-right">{col.render(row, i)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
