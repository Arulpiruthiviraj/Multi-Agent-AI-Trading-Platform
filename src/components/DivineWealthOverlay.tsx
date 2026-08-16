/**
 * ==========================================================
 * COMPONENT: DivineWealthOverlay
 *
 * Sacred Wealth & Divine Abundance Vortex — aesthetic/spiritual
 * mindset theater only. pointer-events: none. No EventBus,
 * RiskEngine, OMS, or real P&L coupling.
 * ==========================================================
 */
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

const AFFIRMATIONS = [
  '🕉️ I AM A LIVING VORTEX OF INFINITE DIVINE ABUNDANCE.',
  "✨ LAKSHMI'S SUPREME FORTUNE FLOWS THROUGH EVERY SYSTEM & THOUGHT.",
  '⚡ GOLD, CAPITAL, AND DIVINE OPPORTUNITY SEEK ME RELENTLESSLY.',
  '👑 STEPPING FULLY INTO SOVEREIGN MILLIONAIRE CONSCIOUSNESS.',
  '💰 MY WEALTH IS COMPOUNDING, SACRED, AND LIMITLESS.',
  '🌟 THE CODE MINES. THE UNIVERSE DELIVERS. WEALTH IS MY NATURAL STATE.',
  '🔥 IT IS ALREADY DONE. MILLIONS ARE ALIGNED AND IN MOTION.',
] as const;

const CYCLE_MS = 8_000;
const WEALTH_GLYPHS = ['🪙', '💵', '💎', '✨', '💰', '🕉️', '🌟', '💫'];

type Faller = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  glyph: string;
  alpha: number;
};

type Ember = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  maxLife: number;
  hue: number;
};

type Burst = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  glyph: string | null;
  color: string;
};

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

/** Faint sacred mandala / yantra watermark (SVG data URI). */
const MANDALA_SVG = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" fill="none">
  <circle cx="200" cy="200" r="180" stroke="#FFD700" stroke-width="1.2" opacity="0.9"/>
  <circle cx="200" cy="200" r="140" stroke="#FFA500" stroke-width="1" opacity="0.8"/>
  <circle cx="200" cy="200" r="100" stroke="#FFD700" stroke-width="1" opacity="0.85"/>
  <circle cx="200" cy="200" r="60" stroke="#00E676" stroke-width="1" opacity="0.7"/>
  <circle cx="200" cy="200" r="24" stroke="#FFD700" stroke-width="1.5" opacity="0.95"/>
  ${Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const x2 = 200 + Math.cos(a) * 180;
    const y2 = 200 + Math.sin(a) * 180;
    return `<line x1="200" y1="200" x2="${x2}" y2="${y2}" stroke="#FFD700" stroke-width="0.8" opacity="0.75"/>`;
  }).join('')}
  <polygon points="200,40 230,160 200,140 170,160" fill="#FFD700" opacity="0.35"/>
  <polygon points="200,360 230,240 200,260 170,240" fill="#FFD700" opacity="0.35"/>
  <polygon points="40,200 160,170 140,200 160,230" fill="#00E676" opacity="0.3"/>
  <polygon points="360,200 240,170 260,200 240,230" fill="#00E676" opacity="0.3"/>
</svg>
`);

export default function DivineWealthOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [index, setIndex] = useState(0);
  const burstTrigger = useRef(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % AFFIRMATIONS.length);
      burstTrigger.current += 1;
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let raf = 0;
    let running = true;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let lastBurstSeen = burstTrigger.current;

    const fallers: Faller[] = [];
    const embers: Ember[] = [];
    const bursts: Burst[] = [];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawnFaller = (fromTop = true): Faller => ({
      x: rand(0, w),
      y: fromTop ? rand(-h * 0.15, -16) : rand(-30, h),
      vx: rand(-0.28, 0.28),
      vy: rand(1.1, 2.8),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.045, 0.045),
      size: rand(18, 36),
      glyph: WEALTH_GLYPHS[(Math.random() * WEALTH_GLYPHS.length) | 0],
      alpha: rand(0.6, 1),
    });

    const spawnEmber = (): Ember => ({
      x: rand(0, w),
      y: h + rand(0, 36),
      vx: rand(-0.2, 0.2),
      vy: rand(-1.6, -0.55),
      r: rand(1.4, 3.6),
      life: 0,
      maxLife: rand(100, 200),
      hue: rand(40, 52),
    });

    const explode = () => {
      const cx = w * 0.5;
      const cy = h * 0.4;
      for (let i = 0; i < 48; i++) {
        const ang = rand(0, Math.PI * 2);
        const spd = rand(2.2, 8.5);
        bursts.push({
          x: cx,
          y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          life: 0,
          maxLife: rand(32, 60),
          size: rand(10, 24),
          glyph: i % 4 === 0 ? WEALTH_GLYPHS[(Math.random() * WEALTH_GLYPHS.length) | 0] : null,
          color: i % 3 === 0 ? '#00E676' : i % 3 === 1 ? '#FFA500' : '#FFD700',
        });
      }
    };

    resize();
    for (let i = 0; i < 34; i++) fallers.push(spawnFaller(false));
    for (let i = 0; i < 64; i++) embers.push(spawnEmber());
    window.addEventListener('resize', resize);

    const tick = () => {
      if (!running) return;

      if (burstTrigger.current !== lastBurstSeen) {
        lastBurstSeen = burstTrigger.current;
        explode();
      }

      ctx.clearRect(0, 0, w, h);

      const wash = ctx.createRadialGradient(w * 0.5, h * 0.42, 30, w * 0.5, h * 0.42, Math.max(w, h) * 0.72);
      wash.addColorStop(0, 'rgba(255,215,0,0.07)');
      wash.addColorStop(0.4, 'rgba(255,165,0,0.04)');
      wash.addColorStop(0.7, 'rgba(0,230,118,0.03)');
      wash.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);

      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.life += 1;
        e.x += e.vx + Math.sin(e.life * 0.07) * 0.18;
        e.y += e.vy;
        const t = e.life / e.maxLife;
        const a = t < 0.12 ? t / 0.12 : t > 0.78 ? (1 - t) / 0.22 : 1;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${e.hue}, 100%, 64%, ${0.6 * a})`;
        ctx.shadowColor = `hsla(${e.hue}, 100%, 58%, ${0.85 * a})`;
        ctx.shadowBlur = 10;
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (e.life >= e.maxLife || e.y < -24) embers[i] = spawnEmber();
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < fallers.length; i++) {
        const f = fallers[i];
        f.x += f.vx;
        f.y += f.vy;
        f.rot += f.vr;
        if (f.y > h + 50 || f.x < -60 || f.x > w + 60) {
          fallers[i] = spawnFaller(true);
          continue;
        }
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.globalAlpha = f.alpha;
        ctx.font = `${f.size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
        ctx.shadowColor = 'rgba(255,215,0,0.7)';
        ctx.shadowBlur = 12;
        ctx.fillText(f.glyph, 0, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Soft shockwave ring on recent burst
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.life += 1;
        b.x += b.vx;
        b.y += b.vy;
        b.vy += 0.1;
        b.vx *= 0.988;
        const t = b.life / b.maxLife;
        const a = 1 - t;
        if (b.glyph) {
          ctx.save();
          ctx.globalAlpha = a;
          ctx.font = `${b.size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
          ctx.fillText(b.glyph, b.x, b.y);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.fillStyle = b.color;
          ctx.globalAlpha = a;
          ctx.shadowColor = b.color;
          ctx.shadowBlur = 14;
          ctx.arc(b.x, b.y, Math.max(1.1, b.size * 0.16), 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }
        if (b.life >= b.maxLife) bursts.splice(i, 1);
      }
      if (bursts.length > 140) bursts.splice(0, bursts.length - 140);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      fallers.length = 0;
      embers.length = 0;
      bursts.length = 0;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[9999] pointer-events-none overflow-hidden"
      aria-hidden="true"
      data-testid="divine-wealth-overlay"
      data-trading-impact="none"
    >
      {/* Liquid gold / amber / emerald radiant field */}
      <motion.div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 95% 75% at 50% 45%, rgba(255,215,0,0.18), transparent 58%), radial-gradient(ellipse 70% 55% at 30% 75%, rgba(255,165,0,0.12), transparent 52%), radial-gradient(ellipse 65% 50% at 75% 25%, rgba(0,230,118,0.14), transparent 50%)',
          willChange: 'opacity',
        }}
        animate={{ opacity: [0.5, 0.95, 0.5] }}
        transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Sacred mandala / yantra watermark */}
      <motion.div
        className="absolute left-1/2 top-[40%] w-[min(92vw,720px)] h-[min(92vw,720px)] -translate-x-1/2 -translate-y-1/2"
        style={{
          backgroundImage: `url("data:image/svg+xml,${MANDALA_SVG}")`,
          backgroundSize: 'contain',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          opacity: 0.1,
          willChange: 'transform, opacity',
          filter: 'drop-shadow(0 0 24px rgba(255,215,0,0.35))',
        }}
        animate={{ rotate: 360, opacity: [0.06, 0.12, 0.06] }}
        transition={{
          rotate: { duration: 90, repeat: Infinity, ease: 'linear' },
          opacity: { duration: 6, repeat: Infinity, ease: 'easeInOut' },
        }}
      />

      {/* Soft sunburst rays */}
      <motion.div
        className="absolute left-1/2 top-[40%] w-[140vmax] h-[140vmax] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: `conic-gradient(from 0deg,
            transparent 0deg,
            rgba(255,215,0,0.06) 10deg,
            transparent 22deg,
            rgba(255,165,0,0.05) 38deg,
            transparent 52deg,
            rgba(0,230,118,0.05) 68deg,
            transparent 88deg,
            rgba(255,215,0,0.07) 105deg,
            transparent 125deg,
            rgba(255,215,0,0.05) 150deg,
            transparent 175deg,
            rgba(0,230,118,0.05) 200deg,
            transparent 230deg,
            rgba(255,165,0,0.06) 260deg,
            transparent 290deg,
            rgba(255,215,0,0.06) 320deg,
            transparent 350deg
          )`,
          willChange: 'transform',
          maskImage: 'radial-gradient(circle, rgba(0,0,0,0.8) 0%, transparent 66%)',
          WebkitMaskImage: 'radial-gradient(circle, rgba(0,0,0,0.8) 0%, transparent 66%)',
        }}
        animate={{ rotate: -360 }}
        transition={{ duration: 72, repeat: Infinity, ease: 'linear' }}
      />

      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Divine affirmation HUD */}
      <div className="absolute inset-x-0 bottom-[8%] flex justify-center px-4">
        <div className="relative w-full max-w-3xl">
          <motion.div
            className="absolute -inset-[2px] rounded-2xl"
            style={{
              background: 'linear-gradient(125deg, #FFD700, #FFA500, #00E676, #FFD700)',
              backgroundSize: '300% 300%',
              filter: 'blur(1.5px)',
              willChange: 'background-position, opacity',
            }}
            animate={{ backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'], opacity: [0.7, 1, 0.7] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
          />

          <div className="relative rounded-2xl border border-amber-300/35 bg-[#0a0704]/88 backdrop-blur-md px-6 py-6 overflow-hidden shadow-[0_0_40px_-8px_rgba(255,215,0,0.55)]">
            <motion.div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(105deg, transparent 28%, rgba(255,248,220,0.22) 50%, transparent 72%)',
                willChange: 'transform',
              }}
              animate={{ x: ['-55%', '155%'] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut', repeatDelay: 1 }}
            />

            <div className="relative text-center text-[9px] font-mono uppercase tracking-[0.32em] text-amber-200/85 mb-3">
              Sacred wealth · Divine abundance · Not P&amp;L · Not a trade signal
            </div>

            <AnimatePresence mode="wait">
              <motion.h2
                key={AFFIRMATIONS[index]}
                className="relative text-center text-lg sm:text-xl md:text-2xl font-bold uppercase leading-snug tracking-wide"
                style={{
                  backgroundImage:
                    'linear-gradient(100deg, #8B6914 0%, #FFD700 20%, #fff8dc 42%, #FFA500 55%, #00E676 72%, #FFD700 100%)',
                  backgroundSize: '220% 100%',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  filter: 'drop-shadow(0 0 20px rgba(255,215,0,0.8)) drop-shadow(0 0 8px rgba(0,230,118,0.45))',
                  textShadow: '0 0 20px rgba(255,215,0,0.8)',
                  willChange: 'transform, opacity, background-position',
                }}
                initial={{ opacity: 0, scale: 0.88, y: 14 }}
                animate={{
                  opacity: 1,
                  scale: [0.88, 1.04, 1],
                  y: 0,
                  backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
                }}
                exit={{ opacity: 0, scale: 1.06, y: -10 }}
                transition={{
                  type: 'spring',
                  stiffness: 200,
                  damping: 18,
                  backgroundPosition: { duration: 4, repeat: Infinity, ease: 'linear' },
                }}
              >
                {AFFIRMATIONS[index]}
              </motion.h2>
            </AnimatePresence>

            <AnimatePresence>
              <motion.div
                key={`pulse-${index}`}
                className="pointer-events-none absolute inset-0 rounded-2xl"
                style={{
                  background:
                    'radial-gradient(circle at 50% 35%, rgba(255,248,220,0.5), transparent 58%)',
                }}
                initial={{ opacity: 0.75, scale: 0.92 }}
                animate={{ opacity: 0, scale: 1.15 }}
                transition={{ duration: 0.85, ease: 'easeOut' }}
              />
            </AnimatePresence>

            <div className="relative mt-4 flex items-center justify-center gap-2">
              <span className="h-px w-10 bg-gradient-to-r from-transparent to-amber-400/80" />
              <span className="text-[9px] font-mono tracking-[0.28em] uppercase text-emerald-300/90 animate-pulse">
                ● Divine energy aligned
              </span>
              <span className="h-px w-10 bg-gradient-to-l from-transparent to-amber-400/80" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
