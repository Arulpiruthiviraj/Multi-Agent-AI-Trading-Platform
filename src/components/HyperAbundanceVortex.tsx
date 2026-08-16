/**
 * ==========================================================
 * COMPONENT: HyperAbundanceVortex
 *
 * Ultra-hypnotic wealth manifestation theater (canvas + motion).
 * pointer-events: none. Zero EventBus / RiskEngine / P&L coupling.
 * ==========================================================
 */
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

const AFFIRMATIONS = [
  'ARGUS IS PRINTING GENERATIONAL WEALTH FOR YOU!',
  'YOU ARE AN UNSTOPPABLE MONEY MAGNET!',
  'GOLD AND ABUNDANCE FLOW TO YOU CONTINUOUSLY!',
  'YOUR EMPIRE IS EXPANDING EVERY SINGLE SECOND!',
  'PURE WEALTH. PURE SUCCESS. YOU ARE A MILLIONAIRE!',
  'THE CODE MINES. THE WEALTH COMPOUNDS. YOU WIN!',
] as const;

const CYCLE_MS = 7_000;
const WEALTH_GLYPHS = ['🪙', '💵', '💸', '💰', '💎', '✨', '💲', '🏆'];

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

export default function HyperAbundanceVortex() {
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
      y: fromTop ? rand(-h * 0.2, -20) : rand(-40, h),
      vx: rand(-0.35, 0.35),
      vy: rand(1.4, 3.6),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.06, 0.06),
      size: rand(16, 38),
      glyph: WEALTH_GLYPHS[(Math.random() * WEALTH_GLYPHS.length) | 0],
      alpha: rand(0.55, 1),
    });

    const spawnEmber = (): Ember => ({
      x: rand(0, w),
      y: h + rand(0, 40),
      vx: rand(-0.25, 0.25),
      vy: rand(-1.8, -0.6),
      r: rand(1.2, 3.4),
      life: 0,
      maxLife: rand(90, 180),
      hue: rand(38, 52),
    });

    const explode = () => {
      const cx = w * 0.5;
      const cy = h * 0.42;
      for (let i = 0; i < 42; i++) {
        const ang = rand(0, Math.PI * 2);
        const spd = rand(2.5, 9);
        bursts.push({
          x: cx,
          y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          life: 0,
          maxLife: rand(28, 55),
          size: rand(10, 22),
          glyph: i % 3 === 0 ? WEALTH_GLYPHS[(Math.random() * WEALTH_GLYPHS.length) | 0] : null,
          color: i % 2 === 0 ? '#FFD700' : '#00FF87',
        });
      }
    };

    resize();
    for (let i = 0; i < 36; i++) fallers.push(spawnFaller(false));
    for (let i = 0; i < 55; i++) embers.push(spawnEmber());
    window.addEventListener('resize', resize);

    const tick = () => {
      if (!running) return;

      if (burstTrigger.current !== lastBurstSeen) {
        lastBurstSeen = burstTrigger.current;
        explode();
      }

      ctx.clearRect(0, 0, w, h);

      // Soft vignette wash (cheap, once per frame)
      const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 40, w * 0.5, h * 0.45, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(255,215,0,0.06)');
      g.addColorStop(0.45, 'rgba(0,255,135,0.03)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // Embers (upward fireflies)
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.life += 1;
        e.x += e.vx + Math.sin(e.life * 0.08) * 0.15;
        e.y += e.vy;
        const t = e.life / e.maxLife;
        const a = t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${e.hue}, 100%, 62%, ${0.55 * a})`;
        ctx.shadowColor = `hsla(${e.hue}, 100%, 55%, ${0.8 * a})`;
        ctx.shadowBlur = 8;
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (e.life >= e.maxLife || e.y < -20) {
          embers[i] = spawnEmber();
        }
      }

      // Falling wealth
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
        ctx.shadowColor = 'rgba(255,215,0,0.65)';
        ctx.shadowBlur = 10;
        ctx.fillText(f.glyph, 0, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Burst particles
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.life += 1;
        b.x += b.vx;
        b.y += b.vy;
        b.vy += 0.12;
        b.vx *= 0.985;
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
          ctx.shadowBlur = 12;
          ctx.arc(b.x, b.y, Math.max(1.2, b.size * 0.18), 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }
        if (b.life >= b.maxLife) bursts.splice(i, 1);
      }

      // Cap burst array growth
      if (bursts.length > 120) bursts.splice(0, bursts.length - 120);

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
      data-testid="hyper-abundance-vortex"
      data-trading-impact="none"
    >
      {/* Ambient gold ↔ emerald breathing pulse */}
      <motion.div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 90% 70% at 50% 50%, rgba(255,215,0,0.16), transparent 58%), radial-gradient(ellipse 70% 55% at 50% 80%, rgba(0,255,135,0.12), transparent 55%)',
          willChange: 'opacity',
        }}
        animate={{ opacity: [0.45, 0.95, 0.45] }}
        transition={{ duration: 3.8, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Rotating god rays */}
      <motion.div
        className="absolute left-1/2 top-[42%] w-[160vmax] h-[160vmax] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: `conic-gradient(from 0deg,
            transparent 0deg,
            rgba(255,215,0,0.07) 12deg,
            transparent 24deg,
            rgba(0,255,135,0.05) 40deg,
            transparent 55deg,
            rgba(255,215,0,0.08) 70deg,
            transparent 90deg,
            rgba(255,215,0,0.06) 110deg,
            transparent 130deg,
            rgba(0,255,135,0.05) 150deg,
            transparent 180deg,
            rgba(255,215,0,0.07) 200deg,
            transparent 220deg,
            rgba(255,215,0,0.05) 250deg,
            transparent 280deg,
            rgba(0,255,135,0.06) 310deg,
            transparent 340deg,
            rgba(255,215,0,0.07) 360deg
          )`,
          willChange: 'transform',
          maskImage: 'radial-gradient(circle, rgba(0,0,0,0.85) 0%, transparent 68%)',
          WebkitMaskImage: 'radial-gradient(circle, rgba(0,0,0,0.85) 0%, transparent 68%)',
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 48, repeat: Infinity, ease: 'linear' }}
      />

      {/* Canvas money engine */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Kinetic affirmation HUD */}
      <div className="absolute inset-x-0 bottom-[9%] flex justify-center px-4">
        <div className="relative w-full max-w-3xl">
          <motion.div
            className="absolute -inset-[3px] rounded-2xl opacity-90"
            style={{
              background: 'linear-gradient(120deg, #FFD700, #00FF87, #22d3ee, #FFD700)',
              backgroundSize: '300% 300%',
              filter: 'blur(2px)',
              willChange: 'background-position, opacity',
            }}
            animate={{ backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'], opacity: [0.65, 1, 0.65] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          />

          <div className="relative rounded-2xl border border-amber-200/40 bg-[#05080f]/88 backdrop-blur-xl px-6 py-6 overflow-hidden">
            <motion.div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(105deg, transparent 25%, rgba(255,255,255,0.18) 50%, transparent 75%)',
                willChange: 'transform',
              }}
              animate={{ x: ['-60%', '160%'] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut', repeatDelay: 0.8 }}
            />

            <div className="relative text-center text-[9px] font-mono uppercase tracking-[0.35em] text-cyan-300/90 mb-3">
              Hyper-abundance hypnosis · Not P&amp;L · Not a trade signal
            </div>

            <AnimatePresence mode="wait">
              <motion.h2
                key={AFFIRMATIONS[index]}
                className="relative text-center text-xl sm:text-2xl md:text-3xl font-black uppercase leading-tight tracking-wide"
                style={{
                  backgroundImage:
                    'linear-gradient(100deg, #8B6914 0%, #FFD700 22%, #fff8dc 45%, #FFD700 58%, #00FF87 78%, #FFD700 100%)',
                  backgroundSize: '220% 100%',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  filter:
                    'drop-shadow(0 0 18px rgba(255,215,0,0.85)) drop-shadow(0 0 6px rgba(0,255,135,0.55))',
                  textShadow: '0 0 30px rgba(255,215,0,0.45)',
                  willChange: 'transform, opacity, background-position',
                }}
                initial={{ opacity: 0, scale: 0.85, y: 16 }}
                animate={{
                  opacity: 1,
                  scale: [0.85, 1.05, 1],
                  y: 0,
                  backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
                }}
                exit={{ opacity: 0, scale: 1.08, y: -12 }}
                transition={{
                  type: 'spring',
                  stiffness: 220,
                  damping: 16,
                  backgroundPosition: { duration: 3.5, repeat: Infinity, ease: 'linear' },
                }}
              >
                {AFFIRMATIONS[index]}
              </motion.h2>
            </AnimatePresence>

            {/* Entry flash */}
            <AnimatePresence>
              <motion.div
                key={`flash-${index}`}
                className="pointer-events-none absolute inset-0 rounded-2xl"
                style={{
                  background:
                    'radial-gradient(circle at 50% 40%, rgba(255,255,220,0.55), transparent 55%)',
                }}
                initial={{ opacity: 0.85 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.7, ease: 'easeOut' }}
              />
            </AnimatePresence>

            <div className="relative mt-4 flex items-center justify-center gap-2">
              <span className="h-px w-12 bg-gradient-to-r from-transparent to-amber-400/70" />
              <span className="text-[9px] font-mono tracking-[0.28em] uppercase text-emerald-300 animate-pulse">
                ● Ultra energy vortex active
              </span>
              <span className="h-px w-12 bg-gradient-to-l from-transparent to-amber-400/70" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
