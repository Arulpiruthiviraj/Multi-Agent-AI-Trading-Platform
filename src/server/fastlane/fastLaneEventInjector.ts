/**
 * Fast Opportunity Lane — event-driven candidate injection.
 *
 * 2026-10-05: Subscribes to NEWS_CATALYST events and injects fast candidates
 * immediately — without waiting for the broad-universe refresh cycle. This is
 * the event-driven path that closes the catalyst-to-evaluation latency gap.
 *
 * Safety: injection creates a RESEARCH object only. It does not emit trade
 * ideas, does not call ChiefTrader, does not place orders. Strategy evaluation
 * and consensus happen downstream through the existing spine.
 */

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { fastLaneManager } from './FastLaneManager';
import { isFastLaneEnabled } from './fastLaneConfig';
import type { NewsCatalyst } from '../services/NewsCatalystStore';
import { observeSafe } from '../observability/StructuredLogger';
import { evaluateFastCandidate } from './fastLaneEvaluator';

let subscribed = false;

/**
 * Map catalyst strength to strategy applicability hints.
 * This is resource prioritization, not execution approval.
 */
function applicabilityForCatalyst(c: NewsCatalyst): Array<'EVENT_MOMENTUM' | 'MOMENTUM_CONTINUATION' | 'GAP_CONTINUATION'> {
  const out: Array<'EVENT_MOMENTUM' | 'MOMENTUM_CONTINUATION' | 'GAP_CONTINUATION'> = ['EVENT_MOMENTUM'];
  if (c.tradingBias !== 'NEUTRAL') out.push('MOMENTUM_CONTINUATION');
  // Gap continuation is a possible follow-through pattern for strong overnight news
  if (c.catalystStrength === 'HIGH') out.push('GAP_CONTINUATION');
  return out;
}

/**
 * Start listening for NEWS_CATALYST events. Idempotent.
 * No-op when the fast lane is disabled.
 */
export function startFastLaneEventInjection(): void {
  if (subscribed) return;
  subscribed = true;
  eventBus.subscribe(EVENTS.NEWS_CATALYST, (catalyst: NewsCatalyst) => {
    observeSafe(() => {
      if (!isFastLaneEnabled()) return;
      // Only inject for meaningful catalysts — LOW strength is noise.
      if (catalyst.catalystStrength === 'LOW') return;
      if (!catalyst.symbol) return;

      const candidate = fastLaneManager.injectCandidate({
        symbol: catalyst.symbol,
        detectionSource: 'NEWS_CATALYST',
        catalyst: catalyst.headline,
        liquidityEvidence: {
          dollarVolume: null,
          spreadBps: null,
          meetsMinLiquidity: false, // resolved at Tier-1 fetch
        },
        requiredDataTier: 'TIER_1',
        applicableStrategies: applicabilityForCatalyst(catalyst),
      });
      // 2026-10-06 (Fast Opportunity Lane Evaluator): real strategy evaluation, fire-and-forget.
      // Produces a FastEvaluationResult and transitions the candidate's lifecycle state, but -
      // deliberately, this phase - never emits a trade idea (see fastLaneEvaluator.ts's own
      // header). A thrown/rejected promise here must never affect the real event-bus subscriber
      // this callback runs inside; evaluateFastCandidate's own try/catch already handles the real
      // evaluation failure path, this is defense-in-depth against the promise itself rejecting.
      if (candidate) {
        void evaluateFastCandidate(candidate.id).catch(() => {});
      }
    });
  });
}

/** For tests: reset subscription state. */
export function resetFastLaneEventInjectionForTests(): void {
  subscribed = false;
}
