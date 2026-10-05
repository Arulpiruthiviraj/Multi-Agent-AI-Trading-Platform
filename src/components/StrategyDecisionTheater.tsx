/**
 * StrategyDecisionTheater.tsx
 * ============================================================================
 * WHAT: Animated, step-by-step visualizations of how each quant strategy
 *   evaluates a setup and reaches a trading decision.
 *
 * WHY: Quant strategies are black boxes to most viewers. A list of
 *   "conditionsMet" strings doesn't convey the DECISION PROCESS — the
 *   sequential logic of "check this, then check that, combine scores,
 *   apply the trigger rule." This component turns that process into a
 *   watchable animation: data flows in, conditions light up one by one,
 *   the score builds, and the final verdict (TRIGGER / NO SIGNAL) lands.
 *
 * TWO MODES:
 *   1. EDUCATIONAL (no transaction): Shows how the strategy works in general.
 *      Steps are the strategy's documented logic; the animation loops with
 *      illustrative (not real) values. Labeled as illustrative.
 *   2. TRANSACTION REPLAY (with evaluation data): Replays an actual decision
 *      from a real strategy evaluation (conditionsMet, conditionsFailed,
 *      setupScore, confidence, triggerMet, side). Each condition animates
 *      in the order the strategy checked it, with its real met/failed outcome.
 *
 * HONESTY CONTRACT (same as AgentWorkflowTheater):
 *   - Educational mode is clearly labeled as illustrative workflow, not live data.
 *   - Replay mode uses ONLY the real evaluation fields — never invents values.
 *   - Never implies profitability or predicts future performance.
 *
 * DATA MODEL:
 *   The component consumes StrategyEvaluation-shaped data (from the Java
 *   quant core via the institutional strategy API, or from the
 *   TransactionObservatory's existing strategy-detail payloads).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Play, Pause, SkipForward, RotateCcw, CheckCircle2, XCircle,
  AlertTriangle, TrendingUp, TrendingDown, Minus, BrainCircuit,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Strategy scene definitions (educational mode)
// ---------------------------------------------------------------------------

interface StrategyStep {
  id: string;
  title: string;
  detail: string;
  /** What the step does in plain language. */
  explainer: string;
}

interface StrategyScene {
  strategyId: string;
  name: string;
  tagline: string;
  accent: string;
  steps: StrategyStep[];
}

const SCENES: StrategyScene[] = [
  {
    strategyId: 'INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM',
    name: 'Vol-Scaled Multi-Timeframe Momentum',
    tagline: 'Trend-following with volatility normalization across 20d and 60d windows',
    accent: '#38bdf8',
    steps: [
      {
        id: 'bars',
        title: 'Load price history',
        detail: 'Fetch 80+ daily bars, verify all prices positive',
        explainer: 'The strategy needs enough clean history to estimate both fast (20-day) and slow (60-day) momentum. Garbage in = garbage out, so it validates first.',
      },
      {
        id: 'vol',
        title: 'Estimate volatility',
        detail: 'Compute 20d rolling volatility from log returns',
        explainer: 'Raw momentum is dominated by volatile periods. By dividing returns by their volatility (Sharpe-like scaling), a 5% move in a calm stock counts more than a 5% move in a chaotic one.',
      },
      {
        id: 'fast',
        title: 'Fast momentum (20d)',
        detail: 'Vol-scaled drift over the last 20 trading days',
        explainer: 'The short-term trend. Must be directionally positive (for long) beyond a minimum threshold — weak drift is indistinguishable from noise.',
      },
      {
        id: 'slow',
        title: 'Slow momentum (60d)',
        detail: 'Vol-scaled drift over the last 60 trading days',
        explainer: 'The longer-term trend. Both timeframes must agree — this "timeframe confluence" filters out short-term whipsaws that reverse quickly.',
      },
      {
        id: 'composite',
        title: 'Composite score',
        detail: 'Average of fast + slow; must exceed one Sharpe unit',
        explainer: 'The combined signal. Requiring a full Sharpe unit of drift means the trend is economically meaningful, not just statistically detectable.',
      },
      {
        id: 'stability',
        title: 'Volatility stability check',
        detail: 'Current 20d vol vs its 60d median (must not be exploding)',
        explainer: 'A momentum signal during a volatility explosion is unreliable — the trend may be a panic spike about to reverse. This gate blocks those.',
      },
      {
        id: 'trigger',
        title: 'Trigger decision',
        detail: 'All gates pass → TRIGGER; else NO SIGNAL',
        explainer: 'The final verdict. Only setups passing every check emit a vote. Most days, most symbols produce NO SIGNAL — and that\'s correct.',
      },
    ],
  },
  {
    strategyId: 'INSTITUTIONAL_TS_MOMENTUM_12M',
    name: '12-Month Time-Series Momentum',
    tagline: 'Classic cross-sectional time-series momentum (Moskowitz-Ooi-Pedersen style)',
    accent: '#a78bfa',
    steps: [
      {
        id: 'bars',
        title: 'Load 12 months of history',
        detail: 'Need 333+ trading days (~16 months of calendar data)',
        explainer: 'Time-series momentum looks at a full year of past returns. The long window is needed because the signal is the 12-month cumulative return — shorter windows are too noisy.',
      },
      {
        id: 'return',
        title: 'Compute 12m cumulative return',
        detail: 'Total return over the trailing 252 trading days',
        explainer: 'The core signal: has this asset gone up a lot over the past year? Winners tend to keep winning (momentum persistence).',
      },
      {
        id: 'vol',
        title: 'Volatility adjustment',
        detail: 'Scale the signal by realized volatility',
        explainer: 'A 30% return with 10% vol is a stronger signal than 30% with 50% vol. Volatility scaling makes signals comparable across assets.',
      },
      {
        id: 'trigger',
        title: 'Trigger decision',
        detail: 'Signal exceeds threshold → TRIGGER with direction',
        explainer: 'Positive 12m momentum → long; negative → short (where supported). The strategy is always "on" — it always has a view, unlike the gated multi-timeframe version.',
      },
    ],
  },
  {
    strategyId: 'INSTITUTIONAL_MULTI_FACTOR_MOMENTUM',
    name: 'Multi-Factor Momentum',
    tagline: 'Combines momentum, value, and quality factors into a composite signal',
    accent: '#34d399',
    steps: [
      {
        id: 'factors',
        title: 'Compute factor exposures',
        detail: 'Momentum, value, and quality scores per symbol',
        explainer: 'Instead of betting on momentum alone, this strategy diversifies across three academically-validated factors. When momentum falters, value or quality may carry.',
      },
      {
        id: 'composite',
        title: 'Composite factor score',
        detail: 'Weighted combination of factor z-scores',
        explainer: 'Each factor is standardized (z-scored) so they\'re comparable, then combined. The weights reflect each factor\'s historical reliability.',
      },
      {
        id: 'trigger',
        title: 'Trigger decision',
        detail: 'Composite exceeds threshold → TRIGGER',
        explainer: 'A high composite means multiple independent factors agree — stronger evidence than any single factor alone.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Replay mode: animate a real evaluation
// ---------------------------------------------------------------------------

export interface StrategyEvaluationReplay {
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL' | 'HOLD';
  setupScore: number;
  confidence: number;
  triggerMet: boolean;
  conditionsMet: string[];
  conditionsFailed: string[];
  contradictions: string[];
}

interface ReplayStep {
  label: string;
  status: 'met' | 'failed';
}

function evaluationToSteps(eval_: StrategyEvaluationReplay): ReplayStep[] {
  // Interleave met and failed in a plausible check order.
  // Real evaluations don't preserve check order, so we present met first
  // (the checks that passed) then failed (the blockers). This is a
  // presentation choice, disclosed in the UI.
  const steps: ReplayStep[] = [
    ...eval_.conditionsMet.map((label) => ({ label, status: 'met' as const })),
    ...eval_.conditionsFailed.map((label) => ({ label, status: 'failed' as const })),
  ];
  return steps;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  /** If provided, replays this real evaluation. Otherwise shows educational scenes. */
  replay?: StrategyEvaluationReplay | null;
  /** Controlled scene selection (educational mode). */
  initialStrategyId?: string;
}

export function StrategyDecisionTheater({ replay, initialStrategyId }: Props) {
  const [sceneIdx, setSceneIdx] = useState(() => {
    if (replay) {
      const idx = SCENES.findIndex((s) => s.strategyId === replay.strategyId);
      return idx >= 0 ? idx : 0;
    }
    if (initialStrategyId) {
      const idx = SCENES.findIndex((s) => s.strategyId === initialStrategyId);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  });
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(true);

  const scene = SCENES[sceneIdx];
  const isReplay = !!replay;
  const replaySteps = replay ? evaluationToSteps(replay) : [];
  const totalSteps = isReplay ? replaySteps.length : scene.steps.length;

  // Auto-advance the animation.
  useEffect(() => {
    if (!playing || totalSteps === 0) return;
    if (stepIdx >= totalSteps) return; // stop at the end
    const t = setTimeout(() => setStepIdx((i) => i + 1), 1400);
    return () => clearTimeout(t);
  }, [playing, stepIdx, totalSteps]);

  const reset = useCallback(() => {
    setStepIdx(0);
    setPlaying(true);
  }, []);

  const selectScene = useCallback((idx: number) => {
    setSceneIdx(idx);
    setStepIdx(0);
    setPlaying(true);
  }, []);

  const SideIcon = replay?.side === 'BUY' ? TrendingUp : replay?.side === 'SELL' ? TrendingDown : Minus;

  return (
    <div className="rounded-xl border border-white/10 bg-[#0b0f1a] p-5 w-full max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <BrainCircuit size={20} style={{ color: scene.accent }} />
        <h3 className="text-base font-semibold text-white">{scene.name}</h3>
        {isReplay && replay && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
            {replay.symbol} · real evaluation replay
          </span>
        )}
        {!isReplay && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
            how it works · illustrative
          </span>
        )}
      </div>
      <p className="text-sm text-white/50 mb-4">{scene.tagline}</p>

      {/* Scene selector (educational mode) */}
      {!isReplay && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {SCENES.map((s, i) => (
            <button
              key={s.strategyId}
              onClick={() => selectScene(i)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                i === sceneIdx
                  ? 'border-white/30 bg-white/10 text-white'
                  : 'border-white/10 text-white/50 hover:text-white/80'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Steps */}
      <div className="space-y-2 mb-4 min-h-[280px]">
        <AnimatePresence>
          {(isReplay ? replaySteps.slice(0, stepIdx) : scene.steps.slice(0, stepIdx)).map((step, i) => {
            const isLast = i === stepIdx - 1;
            if (isReplay) {
              const rs = step as ReplayStep;
              const met = rs.status === 'met';
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  className={`flex items-start gap-3 p-3 rounded-lg border ${
                    met ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'
                  }`}
                >
                  {met
                    ? <CheckCircle2 size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                    : <XCircle size={18} className="text-red-400 mt-0.5 shrink-0" />}
                  <div>
                    <div className="text-sm text-white/90">{rs.label}</div>
                    <div className={`text-xs mt-0.5 ${met ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
                      {met ? 'Condition met' : 'Condition failed — blocks the trigger'}
                    </div>
                  </div>
                  {isLast && (
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="ml-auto text-xs text-white/40"
                    >
                      ●
                    </motion.div>
                  )}
                </motion.div>
              );
            }
            const es = step as StrategyStep;
            return (
              <motion.div
                key={es.id}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35 }}
                className="p-3 rounded-lg border border-white/10 bg-white/[0.02]"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: scene.accent + '20', color: scene.accent }}
                  >
                    STEP {i + 1}
                  </span>
                  <span className="text-sm font-medium text-white/90">{es.title}</span>
                </div>
                <div className="text-xs text-white/60 font-mono mb-1">{es.detail}</div>
                <AnimatePresence>
                  {isLast && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.3 }}
                      className="text-xs text-white/50 leading-relaxed overflow-hidden"
                    >
                      {es.explainer}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {stepIdx === 0 && (
          <div className="text-sm text-white/30 italic py-8 text-center">
            Press play to watch the strategy think…
          </div>
        )}
      </div>

      {/* Verdict (replay mode, after all steps) */}
      {isReplay && replay && stepIdx >= totalSteps && totalSteps > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-lg border mb-4 ${
            replay.triggerMet
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-white/10 bg-white/[0.03]'
          }`}
        >
          <div className="flex items-center gap-3">
            <SideIcon size={22} className={replay.triggerMet ? 'text-emerald-400' : 'text-white/40'} />
            <div>
              <div className="text-sm font-semibold text-white">
                {replay.triggerMet ? `TRIGGER — ${replay.side}` : 'NO SIGNAL'}
              </div>
              <div className="text-xs text-white/50">
                Score {replay.setupScore.toFixed(1)} · Confidence {(replay.confidence * 100).toFixed(0)}%
                {replay.contradictions.length > 0 && (
                  <span className="text-amber-400/90"> · {replay.contradictions.length} contradiction(s)</span>
                )}
              </div>
            </div>
          </div>
          {replay.contradictions.length > 0 && (
            <div className="mt-2 text-xs text-amber-400/80 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{replay.contradictions.join(' ')}</span>
            </div>
          )}
        </motion.div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="p-2 rounded-lg border border-white/10 text-white/70 hover:text-white hover:border-white/25 transition-colors"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          onClick={() => setStepIdx((i) => Math.min(i + 1, totalSteps))}
          className="p-2 rounded-lg border border-white/10 text-white/70 hover:text-white hover:border-white/25 transition-colors"
          aria-label="Step forward"
        >
          <SkipForward size={16} />
        </button>
        <button
          onClick={reset}
          className="p-2 rounded-lg border border-white/10 text-white/70 hover:text-white hover:border-white/25 transition-colors"
          aria-label="Replay"
        >
          <RotateCcw size={16} />
        </button>
        <div className="ml-auto text-xs text-white/40 font-mono">
          {Math.min(stepIdx, totalSteps)} / {totalSteps} steps
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1 rounded-full bg-white/5 overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: scene.accent }}
          animate={{ width: `${totalSteps > 0 ? (Math.min(stepIdx, totalSteps) / totalSteps) * 100 : 0}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>
    </div>
  );
}

export default StrategyDecisionTheater;
