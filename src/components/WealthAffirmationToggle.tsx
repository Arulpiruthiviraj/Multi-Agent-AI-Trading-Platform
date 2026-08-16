/**
 * ==========================================================
 * COMPONENT: WealthAffirmationToggle
 *
 * Settings → Mindset switches for wealth affirmation overlays.
 * Aesthetic preference only — does not change trading gates.
 * ==========================================================
 */
import React from 'react';
import { Sparkles, Gem, Flower2 } from 'lucide-react';
import { useWealthAffirmationSettings } from '../context/WealthAffirmationSettingsContext';

export function WealthAffirmationToggle() {
  const {
    enableWealthAffirmations,
    setEnableWealthAffirmations,
    enableHyperAbundanceMode,
    setEnableHyperAbundanceMode,
    enableDivineWealthMode,
    setEnableDivineWealthMode,
  } = useWealthAffirmationSettings();

  return (
    <div className="space-y-3">
      <div className="bg-[#0F141C] border border-amber-500/20 rounded-lg p-5 flex items-center justify-between gap-4 shadow-[0_0_24px_-12px_rgba(245,158,11,0.35)]">
        <div>
          <h3 className="text-xs font-mono font-bold text-amber-100 uppercase tracking-widest mb-1 flex items-center gap-2">
            <Sparkles size={14} className="text-amber-400" />
            Enable Wealth Manifestation Mode
          </h3>
          <p className="text-xs text-slate-500 max-w-xl leading-relaxed">
            Displays motivational animations and wealth affirmations to maintain a positive trading mindset.
            Browser-only. Not P&amp;L, not live readiness, not a trading signal.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enableWealthAffirmations}
          onClick={() => setEnableWealthAffirmations(!enableWealthAffirmations)}
          className={`shrink-0 w-12 h-6 rounded-full border p-0.5 transition-all ${
            enableWealthAffirmations
              ? 'bg-amber-500/25 border-amber-400/60 shadow-[0_0_12px_rgba(251,191,36,0.45)]'
              : 'bg-slate-800 border-slate-700'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-full transition-transform ${
              enableWealthAffirmations ? 'translate-x-6 bg-amber-300' : 'translate-x-0 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="bg-[#0F141C] border border-amber-400/40 rounded-lg p-5 flex items-center justify-between gap-4 shadow-[0_0_36px_-8px_rgba(255,215,0,0.55)] relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              'radial-gradient(ellipse at 20% 50%, rgba(255,215,0,0.2), transparent 55%), radial-gradient(ellipse at 90% 50%, rgba(0,255,135,0.12), transparent 50%)',
          }}
        />
        <div className="relative">
          <h3 className="text-xs font-mono font-bold text-amber-50 uppercase tracking-widest mb-1 flex items-center gap-2 flex-wrap">
            <Gem size={14} className="text-emerald-300" />
            💎 Hyper-Abundance Hypnosis Mode
            <span className="ml-1 px-2 py-0.5 rounded text-[8px] font-black tracking-[0.2em] bg-gradient-to-r from-amber-400 via-yellow-200 to-emerald-400 text-slate-950 shadow-[0_0_12px_rgba(255,215,0,0.6)]">
              ULTRA ENERGY
            </span>
          </h3>
          <p className="text-xs text-slate-400 max-w-xl leading-relaxed">
            Canvas money vortex, god rays, and powerhouse affirmations. Pure mindset theater —
            <span className="text-amber-200/80"> does not affect orders, risk, or P&amp;L</span>.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enableHyperAbundanceMode}
          onClick={() => setEnableHyperAbundanceMode(!enableHyperAbundanceMode)}
          className={`relative shrink-0 w-12 h-6 rounded-full border p-0.5 transition-all ${
            enableHyperAbundanceMode
              ? 'bg-emerald-400/25 border-amber-300 shadow-[0_0_18px_rgba(255,215,0,0.7)]'
              : 'bg-slate-800 border-slate-700'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-full transition-transform ${
              enableHyperAbundanceMode ? 'translate-x-6 bg-gradient-to-br from-amber-200 to-emerald-300' : 'translate-x-0 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="bg-[#120c06] border border-amber-300/50 rounded-lg p-5 flex items-center justify-between gap-4 shadow-[0_0_40px_-6px_rgba(255,215,0,0.65)] relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              'radial-gradient(ellipse at 15% 40%, rgba(255,215,0,0.25), transparent 50%), radial-gradient(ellipse at 85% 60%, rgba(0,230,118,0.15), transparent 48%), radial-gradient(ellipse at 50% 100%, rgba(255,165,0,0.18), transparent 45%)',
          }}
        />
        <div className="relative">
          <h3 className="text-xs font-mono font-bold text-amber-50 uppercase tracking-widest mb-1 flex items-center gap-2 flex-wrap">
            <Flower2 size={14} className="text-amber-300" />
            🕉️ Sacred Wealth &amp; Divine Abundance Vortex
            <span className="ml-1 px-2 py-0.5 rounded text-[8px] font-black tracking-[0.2em] bg-gradient-to-r from-[#FFD700] via-[#FFA500] to-[#00E676] text-slate-950 shadow-[0_0_14px_rgba(255,215,0,0.75)]">
              DIVINE ENERGY
            </span>
          </h3>
          <p className="text-xs text-slate-400 max-w-xl leading-relaxed">
            Activate sacred gold visuals and high-frequency wealth affirmations for peak mindset alignment.
            Spiritual theater only — never touches RiskEngine, OMS, or real P&amp;L.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enableDivineWealthMode}
          onClick={() => setEnableDivineWealthMode(!enableDivineWealthMode)}
          className={`relative shrink-0 w-12 h-6 rounded-full border p-0.5 transition-all ${
            enableDivineWealthMode
              ? 'bg-amber-400/30 border-[#FFD700] shadow-[0_0_20px_rgba(255,215,0,0.85)]'
              : 'bg-slate-800 border-slate-700'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-full transition-transform ${
              enableDivineWealthMode ? 'translate-x-6 bg-gradient-to-br from-[#FFD700] to-[#00E676]' : 'translate-x-0 bg-white'
            }`}
          />
        </button>
      </div>
    </div>
  );
}
