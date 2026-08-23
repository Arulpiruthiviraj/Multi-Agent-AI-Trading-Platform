/**
 * Synthetic FinBERT → NewsAgent pulse for Digital Twin "Test Event Pulse".
 * Emits NEWS_SENTIMENT_SCORED always (when FinBERT responds).
 * Emits TRADE_IDEA_GENERATED only when NEWS_AGENT_MODE allows votes + Autobot ideas gated on.
 * Never calls placeOrder / RiskEngine / OMS.
 */
import { scoreAndPublishNewsSentiment } from '../services/FinBertService';
import { eventBus } from './EventBus';
import { newsAgentEmitsTradeIdeas } from '../config/deskIntelligence';
import { isLiveIdeaGenerationEnabled } from './ideaGenerationGate';
import { isPipelineAgentEnabled } from './pipelineAgentGate';
import { generateTraceId } from './traceId';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';

export async function runNewsFinBertPulse(opts?: {
  symbol?: string;
  headline?: string;
}): Promise<{
  ok: boolean;
  finbert: boolean;
  ideaEmitted: boolean;
  signedScore: number | null;
  detail: string;
  canPlaceOrders: false;
}> {
  const symbol = looksLikeListedTicker(opts?.symbol || 'NVDA') || 'NVDA';
  const headline =
    opts?.headline
    || `${symbol} announces stronger-than-expected guidance and record demand; shares surge in after-hours trading.`;

  const scored = await scoreAndPublishNewsSentiment({
    text: headline,
    symbol,
    source: 'TestEventPulse',
  });

  if (!scored) {
    return {
      ok: true,
      finbert: false,
      ideaEmitted: false,
      signedScore: null,
      detail: 'FinBERT unreachable (npm run ai:serve / Chronos sentiment). NEWS_SENTIMENT_SCORED not emitted.',
      canPlaceOrders: false,
    };
  }

  let ideaEmitted = false;
  if (
    newsAgentEmitsTradeIdeas()
    && isLiveIdeaGenerationEnabled()
    && isPipelineAgentEnabled('NewsAgent')
    && Math.abs(scored.signedScore) >= 0.15
  ) {
    const side = scored.signedScore >= 0 ? 'BUY' : 'SELL';
    const confidence = Math.min(0.85, 0.45 + Math.abs(scored.signedScore) * 0.4);
    eventBus.emitTradeIdea({
      traceId: generateTraceId(symbol),
      symbol,
      side,
      confidence,
      reasoning: `[News Intelligence / Test Pulse] FinBERT ${scored.label} (${scored.signedScore.toFixed(2)}): ${headline.slice(0, 180)}`,
      agent: 'NewsAgent',
      newsDetails: {
        used: true,
        sentiment: scored.signedScore,
        confidence: scored.score,
        sources: 'TestEventPulse',
        reasoning: headline.slice(0, 240),
      },
    });
    ideaEmitted = true;
  }

  return {
    ok: true,
    finbert: true,
    ideaEmitted,
    signedScore: scored.signedScore,
    detail: ideaEmitted
      ? `FinBERT scored; NewsAgent vote emitted (${newsAgentEmitsTradeIdeas() ? 'ACTIVE_VOTE' : 'mode'}). Still needs 2nd agent + 0.75.`
      : `FinBERT scored (NEWS_SENTIMENT_SCORED). No News vote — set NEWS_AGENT_MODE=ACTIVE_VOTE and Autobot on to vote.`,
    canPlaceOrders: false,
  };
}
