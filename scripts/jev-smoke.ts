/**
 * Jev live smoke test (research spike).
 *
 * Hits the real TypeSafe API with a tiny news-sentiment triage evaluation:
 * one yes/no question + one choice question in a single request.
 *
 * Usage: JEV_API_KEY=<key> npx tsx scripts/jev-smoke.ts
 * Skips gracefully (exit 0) when JEV_API_KEY is unset — safe to run in CI.
 * Costs a few hundred input tokens (~$0.00002) when it actually runs.
 */
import { JevProvider } from '../src/server/ai/providers/JevProvider';

async function main(): Promise<void> {
  const apiKey = (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '').trim();
  if (!apiKey) {
    console.log('[jev-smoke] SKIP: JEV_API_KEY not set — nothing to test.');
    return;
  }

  const provider = new JevProvider();
  await provider.initialize(apiKey);
  console.log('[jev-smoke] authenticated:', await provider.authenticate());

  const state = 'Acme Corp Q3: revenue $2.1B vs $1.9B expected; raised full-year guidance; CEO cites strong enterprise demand.';
  const started = Date.now();
  const result = await provider.evaluate(state, {
    is_bullish: { type: 'noul', instructions: 'Is this news bullish for the stock price?' },
    sentiment: {
      type: 'choice',
      instructions: 'Classify the news sentiment for a trading triage queue',
      criteria: {
        bullish: 'likely positive for the stock price',
        bearish: 'likely negative for the stock price',
        neutral: 'no clear directional implication',
      },
    },
  });
  const elapsedMs = Date.now() - started;

  console.log('[jev-smoke] model answered:', result.model);
  console.log('[jev-smoke] latency:', elapsedMs, 'ms');
  console.log('[jev-smoke] input tokens:', result.inputTokens, '| output tokens:', result.outputTokens);
  console.log('[jev-smoke] estimated cost: $' + provider.estimateCost(result.inputTokens, result.outputTokens).toFixed(6));
  const bullish = result.answers.is_bullish as { noul: number };
  const sentiment = result.answers.sentiment as { choice: string; confidence: number; probabilities: Record<string, number> };
  console.log('[jev-smoke] P(bullish):', bullish.noul.toFixed(3));
  console.log('[jev-smoke] sentiment:', sentiment.choice, '| confidence:', sentiment.confidence.toFixed(3));
  console.log('[jev-smoke] distribution:', JSON.stringify(sentiment.probabilities));
  console.log('[jev-smoke] OK');
}

main().catch((err) => {
  console.error('[jev-smoke] FAILED:', err?.message || err);
  process.exit(1);
});
