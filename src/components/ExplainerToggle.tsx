/**
 * ==========================================================
 * COMPONENT: ExplainerToggle
 *
 * Header / Settings switch for tooltipsEnabled.
 * ==========================================================
 */
import React from 'react';
import { HelpCircle } from 'lucide-react';
import { useExplainerSettings } from '../context/ExplainerSettingsContext';

export function ExplainerToggle({ variant = 'header' }: { variant?: 'header' | 'settings' }) {
  const { tooltipsEnabled, setTooltipsEnabled } = useExplainerSettings();

  if (variant === 'settings') {
    return (
      <div className="bg-[#0F141C] border border-slate-800 rounded-lg p-5 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xs font-mono font-bold text-slate-100 uppercase tracking-widest mb-1 flex items-center gap-2">
            <HelpCircle size={14} className="text-indigo-400" />
            Educational Explainers
          </h3>
          <p className="text-xs text-slate-500 max-w-xl">
            When on, hover a dotted metric label for What it is, Why it matters, and How Argus calculates it.
            Stored in this browser only (`argus_tooltips_enabled`). Does not change trading gates.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={tooltipsEnabled}
          onClick={() => setTooltipsEnabled(!tooltipsEnabled)}
          className={`shrink-0 w-12 h-6 rounded-full border p-0.5 transition-all ${
            tooltipsEnabled ? 'bg-indigo-500/20 border-indigo-500/50' : 'bg-slate-800 border-slate-700'
          }`}
        >
          <div className={`w-4 h-4 rounded-full bg-white transition-transform ${tooltipsEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTooltipsEnabled(!tooltipsEnabled)}
      className={`border px-3 py-1.5 rounded flex items-center gap-2 cursor-pointer transition-all shadow-sm ${
        tooltipsEnabled
          ? 'bg-indigo-500/20 text-indigo-200 border-indigo-500/40'
          : 'bg-slate-800/60 text-slate-400 border-slate-700 hover:bg-slate-700'
      }`}
      title={tooltipsEnabled ? 'Disable educational hover explainers' : 'Enable educational hover explainers'}
    >
      <HelpCircle size={14} />
      <span className="text-[9px] font-bold uppercase tracking-widest hidden sm:inline">Explainers</span>
    </button>
  );
}
