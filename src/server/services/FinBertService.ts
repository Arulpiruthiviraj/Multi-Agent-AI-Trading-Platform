/**
 * FinBERT client facade — HTTP to local Chronos/FinBERT service (`npm run ai:serve`).
 * Never invents sentiment; returns null on failure so callers fail soft to heuristics.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { getFinBertSentiment, type FinBertSentiment } from '../ai/LocalSentiment';

export { getFinBertSentiment, type FinBertSentiment };

export interface NewsSentimentScoredPayload {
  textPreview: string;
  symbol?: string | null;
  label: string;
  score: number;
  signedScore: number;
  model: string;
  source: string;
  at: string;
}

/**
 * Score text with FinBERT and publish NEWS_SENTIMENT_SCORED (observability + NewsAgent path).
 * Does not emit TRADE_IDEA_GENERATED — NewsEngine / Test Pulse own vote policy via newsAgentMode.
 */
export async function scoreAndPublishNewsSentiment(opts: {
  text: string;
  symbol?: string | null;
  source?: string;
}): Promise<NewsSentimentScoredPayload | null> {
  const finbert = await getFinBertSentiment(opts.text);
  if (!finbert) return null;
  const payload: NewsSentimentScoredPayload = {
    textPreview: opts.text.slice(0, 160),
    symbol: opts.symbol ?? null,
    label: finbert.label,
    score: finbert.score,
    signedScore: finbert.signedScore,
    model: finbert.model,
    source: opts.source || 'FinBertService',
    at: new Date().toISOString(),
  };
  eventBus.publish(EVENTS.NEWS_SENTIMENT_SCORED, payload);
  return payload;
}
