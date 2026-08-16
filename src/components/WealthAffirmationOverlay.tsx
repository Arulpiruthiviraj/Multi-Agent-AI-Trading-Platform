/**
 * ==========================================================
 * COMPONENT: WealthAffirmationOverlay
 *
 * High-energy mindset theater: money rain, gold auras, cycling
 * affirmations. NEVER touches EventBus, RiskEngine, OMS, brokers,
 * or real P&L. Animation layer is pointer-events: none.
 * ==========================================================
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

const AFFIRMATIONS = [
  'Argus is mining your money...',
  'You are a millionaire in the making.',
  'Abundance flows to you continuously.',
  'Your wealth is compounding, patience pays.',
  'Patience today, generational wealth tomorrow.',
  'Money streams toward you from every direction.',
  'Your fortune multiplies while you stay focused.',
  'Riches rise to meet your highest vision.',
  'You attract capital like gravity attracts gold.',
  'Every breath draws abundance closer.',
  'Discipline compounds faster than capital.',
  'Wealth finds those who wait with conviction.',
] as const;

/** Decorative ticker amounts — fantasy theater only, not portfolio. */
const FANTASY_TICKS = [
  '+$1,000,000',
  '+$250,000',
  '+$5,000,000',
  '+$88,888',
  '+$10,000,000',
  '+$777,000',
  '+$42,000,000',
  '+$999,999',
] as const;

const CYCLE_MS = 9_000;

type Particle = {
  id: number;
  glyph: string;
  left: number;
  delay: number;
  duration: number;
  size: number;
  drift: number;
  spin: number;
  layer: 'far' | 'mid' | 'near';
};

type FloatCash = {
  id: number;
  text: string;
  left: number;
  delay: number;
  duration: number;
};

function buildParticles(count: number): Particle[] {
  const glyphs = ['🪙', '💵', '💸', '💰', '💎', '✨', '🏆', '💲'];
  return Array.from({ length: count }, (_, i) => {
    const layer: Particle['layer'] = i % 3 === 0 ? 'far' : i % 3 === 1 ? 'mid' : 'near';
    const sizeBase = layer === 'far' ? 12 : layer === 'mid' ? 20 : 32;
    return {
      id: i,
      glyph: glyphs[i % glyphs.length],
      left: (i * 7.3 + (i % 5) * 3.1) % 100,
      delay: (i % 12) * 0.28,
      duration: (layer === 'near' ? 5.5 : layer === 'mid' ? 7.5 : 11) + (i % 4) * 0.45,
      size: sizeBase + (i % 5) * 3,
      drift: (i % 2 === 0 ? 1 : -1) * (18 + (i % 7) * 10),
      spin: (i % 2 === 0 ? 1 : -1) * (25 + (i % 6) * 12),
      layer,
    };
  });
}

function buildFloatCash(count: number): FloatCash[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    text: FANTASY_TICKS[i % FANTASY_TICKS.length],
    left: 8 + ((i * 19) % 80),
    delay: (i % 6) * 0.9,
    duration: 6 + (i % 4) * 1.2,
  }));
}

export default function WealthAffirmationOverlay() {
  const [index, setIndex] = useState(0);
  const [tickIndex, setTickIndex] = useState(0);
  const [vaultPulse, setVaultPulse] = useState(1_000_000);
  const particles = useMemo(() => buildParticles(48), []);
  const floatCash = useMemo(() => buildFloatCash(10), []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % AFFIRMATIONS.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTickIndex((i) => (i + 1) % FANTASY_TICKS.length);
      setVaultPulse((v) => v + 12_500 + ((v / 17) % 88000));
    }, 2200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[80] pointer-events-none overflow-hidden"
      aria-hidden="true"
      data-testid="wealth-affirmation-overlay"
      data-trading-impact="none"
    >
      {/* Full-screen golden shimmer wash */}
      <motion.div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 70% 85%, rgba(251,191,36,0.18), transparent 55%), radial-gradient(ellipse 50% 40% at 20% 20%, rgba(16,185,129,0.12), transparent 50%), radial-gradient(ellipse 40% 30% at 85% 15%, rgba(34,211,238,0.14), transparent 45%)',
          willChange: 'opacity',
        }}
        animate={{ opacity: [0.55, 0.95, 0.55] }}
        transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Pulsing money vault orbs */}
      {[
        { className: 'absolute -bottom-32 -right-20 w-[36rem] h-[36rem]', color: 'rgba(251,191,36,0.32)', dur: 5 },
        { className: 'absolute -top-24 -left-16 w-[28rem] h-[28rem]', color: 'rgba(16,185,129,0.22)', dur: 6.5 },
        { className: 'absolute top-1/3 right-1/4 w-80 h-80', color: 'rgba(34,211,238,0.18)', dur: 4 },
        { className: 'absolute bottom-1/4 left-1/3 w-72 h-72', color: 'rgba(245,158,11,0.2)', dur: 7 },
      ].map((orb, i) => (
        <motion.div
          key={i}
          className={`${orb.className} rounded-full blur-2xl`}
          style={{
            background: `radial-gradient(circle, ${orb.color} 0%, transparent 68%)`,
            willChange: 'transform, opacity',
          }}
          animate={{ opacity: [0.4, 0.95, 0.4], scale: [0.92, 1.12, 0.92] }}
          transition={{ duration: orb.dur, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}

      {/* Dense money rain */}
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute select-none"
          style={{
            left: `${p.left}%`,
            top: '-12%',
            fontSize: p.size,
            zIndex: p.layer === 'near' ? 3 : p.layer === 'mid' ? 2 : 1,
            willChange: 'transform, opacity',
            filter:
              p.layer === 'near'
                ? 'drop-shadow(0 0 12px rgba(251,191,36,0.85)) drop-shadow(0 0 4px rgba(255,255,200,0.6))'
                : 'drop-shadow(0 0 6px rgba(251,191,36,0.45))',
            opacity: p.layer === 'far' ? 0.55 : 1,
          }}
          animate={{
            y: ['0vh', '120vh'],
            x: [0, p.drift * 0.5, p.drift, p.drift * 0.3],
            opacity: p.layer === 'far' ? [0, 0.5, 0.5, 0] : [0, 1, 1, 0],
            rotate: [0, p.spin, p.spin * 2],
            scale: p.layer === 'near' ? [0.85, 1.15, 1] : [1, 1],
          }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            repeat: Infinity,
            ease: 'linear',
          }}
        >
          {p.glyph}
        </motion.span>
      ))}

      {/* Rising fantasy cash amounts */}
      {floatCash.map((c) => (
        <motion.span
          key={`cash-${c.id}`}
          className="absolute font-mono font-bold tracking-wide select-none"
          style={{
            left: `${c.left}%`,
            bottom: '0%',
            fontSize: 13 + (c.id % 4) * 3,
            color: c.id % 2 === 0 ? '#fde68a' : '#6ee7b7',
            textShadow: '0 0 14px rgba(251,191,36,0.9), 0 0 4px rgba(16,185,129,0.7)',
            willChange: 'transform, opacity',
          }}
          animate={{
            y: [40, -520],
            opacity: [0, 1, 1, 0],
            scale: [0.9, 1.15, 1],
          }}
          transition={{
            duration: c.duration,
            delay: c.delay,
            repeat: Infinity,
            ease: 'easeOut',
          }}
        >
          {c.text}
        </motion.span>
      ))}

      {/* Center burst sparkles on affirmation change */}
      <AnimatePresence>
        <motion.div
          key={`burst-${index}`}
          className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 w-0 h-0"
          initial={{ scale: 0.2, opacity: 0 }}
          animate={{ scale: [0.2, 1.8, 0], opacity: [0, 0.7, 0] }}
          transition={{ duration: 1.4, ease: 'easeOut' }}
        >
          <div
            className="w-48 h-48 -ml-24 -mt-24 rounded-full"
            style={{
              background:
                'radial-gradient(circle, rgba(253,230,138,0.55) 0%, rgba(251,191,36,0.2) 35%, transparent 70%)',
            }}
          />
        </motion.div>
      </AnimatePresence>

      {/* Hero affirmation — center-bottom cinematic panel */}
      <div className="absolute inset-x-0 bottom-8 flex justify-center px-4">
        <div className="relative w-full max-w-2xl">
          {/* Glow rim */}
          <motion.div
            className="absolute -inset-[2px] rounded-2xl"
            style={{
              background:
                'linear-gradient(120deg, #fbbf24, #34d399, #22d3ee, #fbbf24)',
              backgroundSize: '300% 300%',
              willChange: 'background-position, opacity',
              filter: 'blur(1px)',
            }}
            animate={{ backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'], opacity: [0.7, 1, 0.7] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
          />
          <div className="relative rounded-2xl border border-amber-200/30 bg-[#070b12]/92 backdrop-blur-xl px-6 py-5 overflow-hidden">
            <motion.div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background:
                  'linear-gradient(105deg, transparent 30%, rgba(253,230,138,0.25) 50%, transparent 70%)',
                willChange: 'transform',
              }}
              animate={{ x: ['-40%', '140%'] }}
              transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut', repeatDelay: 1.2 }}
            />

            <div className="flex items-center justify-between gap-3 mb-2 relative">
              <div className="text-[9px] font-mono uppercase tracking-[0.32em] text-cyan-300">
                Manifestation theater · Not P&amp;L · Not a trade signal
              </div>
              <AnimatePresence mode="wait">
                <motion.span
                  key={FANTASY_TICKS[tickIndex]}
                  className="text-[11px] font-mono font-bold text-emerald-300"
                  style={{ textShadow: '0 0 12px rgba(52,211,153,0.8)' }}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.35 }}
                >
                  {FANTASY_TICKS[tickIndex]}
                </motion.span>
              </AnimatePresence>
            </div>

            <AnimatePresence mode="wait">
              <motion.p
                key={AFFIRMATIONS[index]}
                className="relative text-center text-2xl md:text-3xl leading-tight text-amber-50 font-semibold"
                style={{
                  fontFamily: 'Georgia, "Palatino Linotype", "Times New Roman", serif',
                  textShadow:
                    '0 0 28px rgba(251,191,36,0.75), 0 0 8px rgba(34,211,238,0.45), 0 2px 0 rgba(0,0,0,0.45)',
                  willChange: 'opacity, transform',
                }}
                initial={{ opacity: 0, y: 18, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -14, scale: 1.02 }}
                transition={{ duration: 0.55, ease: 'easeOut' }}
              >
                {AFFIRMATIONS[index]}
              </motion.p>
            </AnimatePresence>

            <div className="relative mt-4 flex items-end justify-between gap-4">
              <div>
                <div className="text-[8px] font-mono uppercase tracking-[0.25em] text-amber-400/70 mb-1">
                  Fantasy abundance meter
                </div>
                <motion.div
                  key={Math.floor(vaultPulse)}
                  className="text-xl md:text-2xl font-mono font-bold text-transparent bg-clip-text"
                  style={{
                    backgroundImage: 'linear-gradient(90deg, #fde68a, #34d399, #22d3ee, #fbbf24)',
                    backgroundSize: '200% 100%',
                    filter: 'drop-shadow(0 0 10px rgba(251,191,36,0.55))',
                  }}
                  initial={{ opacity: 0.5, scale: 0.98 }}
                  animate={{
                    opacity: 1,
                    scale: [1, 1.04, 1],
                    backgroundPosition: ['0% 50%', '100% 50%'],
                  }}
                  transition={{ duration: 0.9 }}
                >
                  ${Math.floor(vaultPulse).toLocaleString()}
                </motion.div>
              </div>
              <div className="text-right">
                <div className="text-[9px] font-mono text-emerald-400/80 uppercase tracking-widest animate-pulse">
                  ● Energy rising
                </div>
                <div className="text-[9px] font-mono text-amber-200/60 uppercase tracking-widest mt-1">
                  Wealth manifestation mode
                </div>
              </div>
            </div>

            {/* Energy bar */}
            <div className="relative mt-3 h-1.5 rounded-full bg-slate-900/80 overflow-hidden border border-amber-500/20">
              <motion.div
                className="h-full rounded-full"
                style={{
                  background: 'linear-gradient(90deg, #f59e0b, #34d399, #22d3ee, #fbbf24)',
                  backgroundSize: '200% 100%',
                  willChange: 'transform, background-position',
                }}
                animate={{
                  x: ['-30%', '0%'],
                  backgroundPosition: ['0% 50%', '100% 50%'],
                  scaleX: [0.55, 1, 0.75, 1],
                }}
                transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
