import React, { useState } from 'react';
import { Gauge } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { JsonDetailModal } from './JsonDetailModal';
import { truncateText } from './mobileUtils';

function field(label: string, value: unknown) {
  const display =
    value == null || value === ''
      ? '--'
      : typeof value === 'number'
        ? Number.isFinite(value) ? value.toFixed(4) : '--'
        : typeof value === 'string'
          ? truncateText(value, 80)
          : truncateText(JSON.stringify(value), 80);
  return (
    <div className="py-1.5 border-b border-slate-800/60 last:border-0">
      <p className="text-[9px] font-mono uppercase text-slate-500">{label}</p>
      <p className="text-[11px] font-mono text-slate-200 break-all">{display}</p>
    </div>
  );
}

export function MobileQuantInspector() {
  const quant = useMobileMissionSelector((s) => s.quant);
  const [jsonOpen, setJsonOpen] = useState(false);

  const q = quant as Record<string, unknown> | null;
  const featureSnapshot = q?.featureSnapshot as Record<string, unknown> | undefined;
  const tradeThesis = q?.tradeThesis as Record<string, unknown> | undefined;
  const regime = q?.regime ?? featureSnapshot?.regime;
  const strategy = q?.strategyId ?? q?.selectedStrategy ?? tradeThesis?.strategyId;
  const ev = tradeThesis?.expectedValueR ?? tradeThesis?.evInR ?? q?.expectedValue;
  const kelly = tradeThesis?.kellyFraction ?? q?.kellyFraction;
  const sr = featureSnapshot?.supportResistance ?? featureSnapshot?.nearestSupport;
  const atr = featureSnapshot?.atr ?? featureSnapshot?.ATR;
  const invalidation = tradeThesis?.invalidationRules ?? tradeThesis?.invalidation;

  return (
    <>
      <section className="rounded-xl border border-slate-800 bg-[#111822] p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gauge size={16} className="text-sky-400" />
          <h2 className="text-xs font-mono uppercase tracking-widest text-slate-200">Quant inspector</h2>
        </div>
        {!quant && (
          <p className="text-[10px] font-mono text-slate-500">
            No quant_assessments join on latest transaction — shows -- (never invented).
          </p>
        )}
        {field('Strategy', strategy)}
        {field('Regime', regime)}
        {field('EV (R)', ev)}
        {field('Kelly fraction', kelly)}
        {field('S/R', sr)}
        {field('ATR', atr)}
        {field('Invalidation', invalidation)}
        <button
          type="button"
          onClick={() => setJsonOpen(true)}
          className="mt-3 text-[10px] font-mono text-indigo-400 underline min-h-[44px]"
        >
          Full quant JSON
        </button>
      </section>
      <JsonDetailModal open={jsonOpen} title="Quant assessment" data={quant} onClose={() => setJsonOpen(false)} />
    </>
  );
}
