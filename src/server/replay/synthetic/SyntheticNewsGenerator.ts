/**
 * Synthetic Market Session Simulator (2026-09-14 mandate), Phase 5: synthetic news events.
 *
 * Honest scope note: this is a SIMPLIFIED synthetic news path, not a full synthetic
 * NewsEngine.runPipeline() (that class's real logic is fundamentally network-dependent - live RSS
 * feeds + paid news APIs + an LLM call - none of which a deterministic isolated simulation should
 * invoke). Instead this generator builds a real HistoricalNewsProvider (the exact interface
 * RiskEngine's news_veto gate reads when a replay-shaped session is active - see
 * HistoricalNewsProvider.ts / newsVisibleAt()) directly from the scenario's own NEWS_SHOCK events,
 * so a synthetic news item genuinely exercises the real gate 14 logic, even though the "how a news
 * event is discovered" step (RSS polling, LLM scoring) is not itself simulated. It also writes a
 * matching row into the real `news_clusters` table for observability/export parity with a live
 * session, though that table is NOT what gate 14 reads while a synthetic (replay-shaped) session is
 * active (see RiskEngine.ts's `if (replay) {...} else {...}` branch on the news_veto gate).
 *
 * Real, worth-knowing nuance found while wiring this: the REPLAY branch of gate 14 (which a
 * synthetic session also takes, since it installs a replay-shaped ActiveReplaySession) only vetoes
 * on `sentiment < -0.99` - i.e. only a strongly NEGATIVE item blocks, unlike live mode's
 * direction-blind "any high-impact cluster blocks" rule. A NEWS_SHOCK with newsDirection:
 * 'POSITIVE' (sentiment +0.8) therefore does NOT veto trading on that symbol - only a deliberately
 * near-maximal negative shock would.
 *
 * Isolation note (2026-09-14, real incident found and fixed during Phase 1 smoke testing): `db`
 * is deliberately imported DYNAMICALLY inside persistSyntheticNewsItem() below, never at this
 * file's top level. A static top-level `import { db } from '../../db'` here would make db/index.ts
 * evaluate (opening a real SQLite connection against whatever ARGUS_DB_PATH happens to be set to
 * at that moment) the instant ANY caller imports this module - including before
 * SyntheticSessionEngine's own isolation setup has had a chance to set an isolated ARGUS_DB_PATH,
 * since ES module imports are resolved eagerly. This exact mistake caused a real, confirmed
 * production-database pollution incident (3 spurious settings rows + 20 synthetic SPY/QQQ
 * ohlcv_bars rows written to the live data/argus.db) before it was caught and fixed - see
 * SyntheticSessionEngine.ts's own header comment for the full incident note.
 */
import type { ScenarioEvent, ScenarioProfile } from './SyntheticScenario';
import type { HistoricalNewsProvider } from '../HistoricalNewsProvider';
import type { HistoricalNewsItem } from '../loadGoldenReplayDataset';

export interface SyntheticNewsItem {
  id: string;
  title: string;
  symbols: string[];
  sentimentScore: number; // -1..1
  impactScore: number; // 0..100
  createdAtMs: number;
}

function buildHeadline(event: ScenarioEvent, symbol: string): string {
  const magnitude = event.newsMagnitude === 'HIGH_IMPACT' ? 'Major' : 'Minor';
  const direction = event.newsDirection === 'NEGATIVE' ? 'negative' : 'positive';
  return `[SYNTHETIC] ${magnitude} ${direction} catalyst reported for ${symbol}`;
}

/** Deterministic, pure - given the same scenario/universe/simulated-time offset, always produces
 *  the same news items (no RNG dependency, since the event's magnitude/direction are already fixed
 *  in the scenario definition). */
export function buildSyntheticNewsItemsForEvent(event: ScenarioEvent, sessionStartMs: number, universeSymbols: string[]): SyntheticNewsItem[] {
  if (event.type !== 'NEWS_SHOCK') return [];
  const symbols = event.symbols && event.symbols.length > 0 ? event.symbols : universeSymbols.slice(0, 1);
  const createdAtMs = sessionStartMs + event.atOffsetMs;
  const sentimentScore = event.newsDirection === 'NEGATIVE' ? -0.8 : 0.8;
  const impactScore = event.newsMagnitude === 'HIGH_IMPACT' ? 90 : 45;
  return symbols.map((symbol, i) => ({
    id: `synth-news-${createdAtMs}-${symbol}-${i}`,
    title: buildHeadline(event, symbol),
    symbols: [symbol],
    sentimentScore,
    impactScore,
    createdAtMs,
  }));
}

/** Persists a synthetic news item into the REAL news_clusters table - the exact table/shape gate
 *  14 news_veto reads. Isolated-DB-only (this module never touches the live engine's database;
 *  the caller is responsible for having set an isolated ARGUS_DB_PATH before this runs, same
 *  convention as every other forensic/simulation harness this codebase already uses). */
export async function persistSyntheticNewsItem(item: SyntheticNewsItem): Promise<void> {
  const nowIso = new Date(item.createdAtMs).toISOString();
  const { db } = await import('../../db');
  const { newsClusters } = await import('../../db/schema');
  await db.insert(newsClusters).values({
    id: item.id,
    title: item.title,
    summary: item.title,
    createdAt: nowIso,
    updatedAt: nowIso,
    eventType: 'SYNTHETIC_SIMULATION',
    sentimentScore: item.sentimentScore,
    impactScore: item.impactScore,
    timeHorizon: 'INTRADAY',
    symbols: JSON.stringify(item.symbols),
    articleCount: 1,
    sourceCount: 1,
  }).onConflictDoNothing();
}

/** Convenience: generate + persist every NEWS_SHOCK event a scenario defines, for a given session
 *  start time and symbol universe. Called once by SyntheticSessionEngine at session setup (all
 *  news items are point-in-time-dated to their real event offset, exactly as if they had streamed
 *  in live at that moment - the simulator's own clock/visibility rules, not this function, are
 *  responsible for not letting an agent "see" a news item before its createdAtMs). */
export async function seedSyntheticNewsForScenario(scenario: ScenarioProfile, sessionStartMs: number, universeSymbols: string[]): Promise<SyntheticNewsItem[]> {
  const items: SyntheticNewsItem[] = [];
  for (const event of scenario.events) {
    const eventItems = buildSyntheticNewsItemsForEvent(event, sessionStartMs, universeSymbols);
    for (const item of eventItems) {
      await persistSyntheticNewsItem(item);
      items.push(item);
    }
  }
  return items;
}

/** The actual integration point RiskEngine's news_veto gate reads while a synthetic (replay-shaped)
 *  session is active - see HistoricalNewsProvider.ts's newsVisibleAt(provider, cutoff, symbol).
 *  Pure/synchronous, built directly from already-generated SyntheticNewsItem[] (no DB read needed -
 *  the items came from the deterministic scenario definition in the first place). */
export function buildSyntheticNewsProvider(items: SyntheticNewsItem[]): HistoricalNewsProvider {
  const historicalItems: HistoricalNewsItem[] = items.map((item) => ({
    newsId: item.id,
    publishedAt: item.createdAtMs,
    source: 'synthetic_simulation',
    headline: item.title,
    summary: item.title,
    url: '',
    symbols: item.symbols,
    sentiment: item.sentimentScore,
    sourceTimestamp: item.createdAtMs,
  }));
  return {
    id: 'synthetic_simulation_news',
    available: true,
    status: 'AVAILABLE',
    note: 'Synthetic Market Session Simulator news - deterministic, scenario-defined, never a live feed.',
    all: () => historicalItems,
  };
}
