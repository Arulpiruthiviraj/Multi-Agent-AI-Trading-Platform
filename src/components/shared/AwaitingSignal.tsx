/**
 * ==========================================================
 * Module: AwaitingSignal
 *
 * Purpose:
 * Task 3D of FINAL_ANALYSIS.md's 4-phase remediation plan - a single, honest empty-state for a
 * genuinely missing real data point (e.g. a symbol with too few real OHLCV bars, or an agent pair
 * with no overlapping real predictions yet). Every fabricated-data widget being wired to a real
 * endpoint in this pass (StrategyScanner, StrategySynergyMatrix) needs the exact same shape of
 * "this is real, and real data for this cell genuinely doesn't exist yet" - previously each widget
 * either silently rendered a zero/blank or (worse) fabricated a plausible-looking number instead.
 * ==========================================================
 */
import React from "react";
import { RadioTower } from "lucide-react";

interface AwaitingSignalProps {
  reason?: string;
  label?: string;
  compact?: boolean;
}

export default function AwaitingSignal({ reason, label, compact }: AwaitingSignalProps) {
  if (compact) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-600 uppercase tracking-wider"
        title={reason}
      >
        <RadioTower size={10} /> AWAITING SIGNAL
      </span>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <RadioTower size={20} className="text-slate-600" />
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
        {label ? `${label} — ` : ""}AWAITING SIGNAL
      </div>
      {reason && <div className="text-[10px] text-slate-600 max-w-xs leading-relaxed">{reason}</div>}
    </div>
  );
}
