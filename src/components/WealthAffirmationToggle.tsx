/**
 * ==========================================================
 * COMPONENT: WealthAffirmationToggle
 *
 * Settings → Preferences · Mindset — single master card for the
 * Divine Wealth & Hyper-Abundance Vortex theater experience.
 * Aesthetic preference only — does not change trading gates.
 * ==========================================================
 */
import React, { useEffect, useState } from 'react';
import { Sparkles, Volume2, VolumeX } from 'lucide-react';
import { useWealthAffirmationSettings } from '../context/WealthAffirmationSettingsContext';
import type { WealthVortexMode } from '../context/wealthVortexStore';

const AFFIRMATIONS = [
  'Capital flows effortlessly to high-probability setups',
  'Argus operates in harmonic alignment with market liquidity',
  'Maximum risk discipline yields limitless abundance',
  'Patience compounds faster than leverage',
  'Clarity precedes conviction; conviction precedes capital',
  'Every gated decision protects tomorrow’s abundance',
  'Stillness of mind, precision of execution',
  'Wealth follows process — process follows discipline',
] as const;

const AFFIRMATION_MS = 10_000;

const MODE_OPTIONS: { value: WealthVortexMode; label: string; hint: string }[] = [
  {
    value: 'sacred_gold_flow',
    label: 'Sacred Gold Flow',
    hint: 'Subtle golden card glows + ambient particles',
  },
  {
    value: 'hyper_abundance_777',
    label: 'Hyper-Abundance 777Hz',
    hint: 'God rays, canvas money vortex, animated particle flow',
  },
  {
    value: 'divine_omnipresent',
    label: 'Divine Omnipresent Vortex',
    hint: 'Full-screen ambient aura, glowing equity cards, pulsing neon borders',
  },
];

export function WealthAffirmationToggle() {
  const { enabled, mode, sound, setEnabled, setMode, setSound } = useWealthAffirmationSettings();
  const [affirmationIndex, setAffirmationIndex] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      setAffirmationIndex((i) => (i + 1) % AFFIRMATIONS.length);
    }, AFFIRMATION_MS);
    return () => window.clearInterval(id);
  }, [enabled]);

  return (
    <div
      className="bg-[#0F141C] border border-amber-500/40 hover:border-amber-400/80 rounded-lg p-5 shadow-[0_0_20px_rgba(245,158,11,0.15)] relative overflow-hidden transition-colors"
      data-testid="wealth-vortex-master-card"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(ellipse at 15% 40%, rgba(245,158,11,0.18), transparent 55%), radial-gradient(ellipse at 90% 60%, rgba(34,211,238,0.12), transparent 50%)',
        }}
      />

      <div className="relative space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-mono font-bold text-amber-50 uppercase tracking-widest mb-1.5 flex items-center gap-2 flex-wrap">
              <Sparkles size={14} className="text-amber-300 shrink-0" />
              <span>💎🕉️ DIVINE WEALTH &amp; HYPER-ABUNDANCE VORTEX</span>
              <span className="px-2 py-0.5 rounded text-[8px] font-black tracking-[0.18em] bg-gradient-to-r from-amber-400 via-yellow-200 to-amber-500 text-slate-950 shadow-[0_0_12px_rgba(245,158,11,0.55)]">
                QUANTUM ABUNDANCE
              </span>
            </h3>
            <p className="text-xs text-slate-500 max-w-xl leading-relaxed">
              Mindset theater &amp; browser visual effects only — strictly isolated from RiskEngine, OMS,
              and broker execution.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Enable Divine Wealth & Hyper-Abundance Vortex"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative shrink-0 w-12 h-6 rounded-full border p-0.5 transition-all ${
              enabled
                ? 'bg-amber-500/25 border-amber-400/70 shadow-[0_0_16px_rgba(245,158,11,0.55)]'
                : 'bg-slate-800 border-slate-700'
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full transition-transform ${
                enabled
                  ? 'translate-x-6 bg-gradient-to-br from-amber-200 to-cyan-300'
                  : 'translate-x-0 bg-white'
              }`}
            />
          </button>
        </div>

        {enabled && (
          <>
            <div className="space-y-1.5">
              <label
                htmlFor="wealth-vortex-mode"
                className="text-[10px] font-mono font-bold text-amber-200/80 uppercase tracking-[0.15em]"
              >
                Mode / Intensity
              </label>
              <select
                id="wealth-vortex-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as WealthVortexMode)}
                className="w-full bg-[#0A0E14] border border-amber-500/30 hover:border-amber-400/50 text-amber-50 text-xs font-mono rounded-md px-3 py-2.5 outline-none focus:border-amber-400/70 transition-colors"
              >
                {MODE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                {MODE_OPTIONS.find((o) => o.value === mode)?.hint}
              </p>
            </div>

            <div
              className="rounded-md border border-amber-500/25 bg-gradient-to-r from-amber-500/10 via-transparent to-cyan-500/10 px-3 py-2.5 overflow-hidden"
              aria-live="polite"
            >
              <div className="text-[9px] font-mono font-bold text-amber-400/70 uppercase tracking-[0.2em] mb-1">
                Dynamic Affirmation
              </div>
              <p key={affirmationIndex} className="text-xs text-amber-100/90 font-medium tracking-wide">
                {AFFIRMATIONS[affirmationIndex]}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2 min-w-0">
                {sound ? (
                  <Volume2 size={14} className="text-amber-300 shrink-0" />
                ) : (
                  <VolumeX size={14} className="text-slate-500 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-[10px] font-mono font-bold text-slate-200 uppercase tracking-widest">
                    Sound / Chime
                  </div>
                  <p className="text-[11px] text-slate-500 leading-snug">
                    Soft harmonic on master toggle or order fill
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Wealth vortex sound chime"
                aria-checked={sound}
                onClick={() => setSound(!sound)}
                className={`shrink-0 w-12 h-6 rounded-full border p-0.5 transition-all ${
                  sound
                    ? 'bg-cyan-500/20 border-cyan-400/50 shadow-[0_0_12px_rgba(34,211,238,0.35)]'
                    : 'bg-slate-800 border-slate-700'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full transition-transform ${
                    sound ? 'translate-x-6 bg-cyan-300' : 'translate-x-0 bg-white'
                  }`}
                />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
