import React, { useRef } from 'react';
import { ChevronLeft, ChevronRight, Wallet, Shield, ArrowUpRight } from 'lucide-react';

export type MetricCard = {
  id: string;
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: 'emerald' | 'rose' | 'neutral';
  icon?: React.ReactNode;
};

export type ResponsiveMetricCarouselProps = {
  metrics: MetricCard[];
  className?: string;
};

export function ResponsiveMetricCarousel({ metrics, className = '' }: ResponsiveMetricCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * (el.clientWidth * 0.85), behavior: 'smooth' });
  };

  return (
    <section
      className={`argus-compact-only relative bg-[#1A1F2B]/40 border-b border-slate-850 ${className}`}
      id="stats-ribbon-carousel"
      aria-label="Portfolio metrics"
    >
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Portfolio metrics</span>
        <div className="flex gap-1">
          <button type="button" onClick={() => scroll(-1)} className="argus-touch-target p-2 rounded border border-slate-800 text-slate-400 hover:text-white" aria-label="Previous metric">
            <ChevronLeft size={16} />
          </button>
          <button type="button" onClick={() => scroll(1)} className="argus-touch-target p-2 rounded border border-slate-800 text-slate-400 hover:text-white" aria-label="Next metric">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="argus-metric-carousel flex gap-3 overflow-x-auto px-4 py-4 pb-5 scrollbar-hide"
      >
        {metrics.map((m) => {
          const valueCls =
            m.accent === 'rose' ? 'text-rose-400'
              : m.accent === 'emerald' ? 'text-emerald-400'
                : 'text-white';
          const subCls =
            m.accent === 'rose' ? 'text-rose-400'
              : m.accent === 'emerald' ? 'text-emerald-400'
                : 'text-slate-500';
          return (
            <div
              key={m.id}
              className="min-w-[72vw] sm:min-w-[280px] shrink-0 p-4 bg-[#1A1F2B]/50 rounded-lg border border-slate-800/60"
            >
              <div className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-1 flex items-center justify-between">
                <span>{m.label}</span>
                {m.icon ?? (m.id === 'equity' ? <Wallet size={12} className="text-slate-500" /> : m.id === 'health' ? <Shield size={12} className="text-emerald-400" /> : null)}
              </div>
              <div className={`text-xl font-bold ${valueCls}`}>{m.value}</div>
              {m.sub && (
                <div className={`text-[10px] font-mono mt-1 flex items-center gap-0.5 ${subCls}`}>
                  {m.id === 'equity' && <ArrowUpRight size={10} />}
                  {m.sub}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
