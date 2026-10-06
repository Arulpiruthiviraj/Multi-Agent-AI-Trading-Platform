/**
 * Mover cohort builder (2026-10-06, local-only, Part B workstream H).
 *
 * Builds the EOD benchmark mover cohort for one trading date: the day's real,
 * investable-universe market movers, INDEPENDENT of what Argus's discovery pipeline
 * happened to see. This independence is the whole point - the pre-existing
 * post-market reflection only ever classified symbols Argus already touched
 * (survivorship bias), which made TRUE_UNIVERSE_MISS unreachable. The reconciler
 * (coverageReconciler.ts) joins this cohort against the real discovery lineage to
 * make that code genuinely reachable.
 *
 * Benchmark definition ("intended investable universe"):
 *  - Source: the SAME real Alpaca /v1beta1/screener/stocks/movers endpoint the
 *    MarketUniverseScanner movers funnel uses (same credentials, same top-N), for the
 *    trading date itself. For a PAST trading date the live screener is useless (it only
 *    serves "today"), so the cohort is recomputed honestly from the same provider's
 *    historical 1Day bars over the tradable-assets universe - documented below, never
 *    presented as screener output.
 *  - Investable screens: the same price / dollar-volume / spread / ADV gates the funnel
 *    enforces, read from the same config/continuousIntelligence.json values (never
 *    TypeScript literals - see AGENTS.md). Penny/microcap noise is excluded unless the
 *    mandate (config) says otherwise. Members beyond moversTopNPerScan are KEPT and
 *    flagged beyondScanCap - they are exactly the RANK_CAP never-seen cases.
 *  - eod_move_pct is always computed from real bars (prev close -> close), never from
 *    the screener's intraday percent_change.
 *
 * Honest degradation: when the market-data provider is unavailable (no Alpaca keys)
 * or returns no usable data, the cohort is marked insufficientEvidence - members is
 * empty and NO synthetic movers are fabricated. runDailyReflection() persists nothing
 * in that case and reports INSUFFICIENT_EVIDENCE.
 *
 * Diagnostic only. Never imports RiskEngine/OMS/BrokerManager, never emits
 * TRADE_IDEA_GENERATED, never places an order, never changes a threshold.
 */
import { continuousIntelligence } from '../config/continuousIntelligence';
import { logErrorSafely } from '../core/SecretRedaction';

export type MoverDirection = 'GAINER' | 'LOSER';

export interface RawMover {
  symbol: string;
  /** Screener's own percent_change (intraday vs prev close) - used only for candidate
   *  selection/ranking, never persisted as the benchmark move. */
  percentChange: number | null;
  price: number | null;
}

/** Stage-1 screen evidence for one symbol (price/dollar-volume/spread). */
export interface SnapshotEvidence {
  symbol: string;
  price: number | null;
  dollarVolume: number | null;
  spreadBps: number | null;
  spreadCrossed: boolean;
}

/** Two-session daily-bar evidence for the EOD move computation. */
export interface DailyBarEvidence {
  prevClose: number | null;
  close: number | null;
  volume: number | null;
}

export interface MoverCohortMember {
  symbol: string;
  direction: MoverDirection;
  /** Real EOD move %: (close - prevClose) / prevClose * 100. Null when bars unavailable. */
  eodMovePct: number | null;
  /** Previous session close - the benchmark reference price. */
  referencePrice: number | null;
  dayVolumeShares: number | null;
  /** 1-based rank within its side (screener order for the same-date path, |eodMovePct|
   *  order for the bars-derived past-date path). Used for RANK_CAP cause determination. */
  screenerRank: number | null;
  /** True when screenerRank > scanTopNPerSide - the funnel's rank cap would have cut it. */
  beyondScanCap: boolean;
  /** Membership in the Alpaca tradable-assets universe (active, allowed exchanges).
   *  Recorded, not screened on - the funnel itself does not check this; the reconciler
   *  uses it for the UNIVERSE_COVERAGE never-seen cause. */
  inTradableUniverse: boolean | null;
  screenEvidence: {
    price: number | null;
    dollarVolume: number | null;
    spreadBps: number | null;
    spreadCrossed: boolean;
    advShares: number | null;
    /** False on the bars-derived past-date path - no quote/spread exists post-hoc. */
    spreadScreened: boolean;
  };
}

export interface MoverCohortResult {
  tradingDate: string;
  members: MoverCohortMember[];
  insufficientEvidence: boolean;
  insufficientReason: string | null;
  providerName: string;
  providerAvailable: boolean;
  /** Raw candidate count before screens (screener fetch size, or tradable-assets size). */
  universeSize: number | null;
  /** Candidates excluded by the investable screens (not in the benchmark). */
  screenedOut: number;
  fetchedAtIso: string;
}

/**
 * Market-data provider abstraction. The production implementation is real Alpaca
 * (same endpoints/credentials as MarketUniverseScanner); tests inject fakes. The
 * interface is deliberately narrow: the cohort builder owns selection, screening,
 * and ranking - the provider only fetches real data.
 */
export interface MoverDataProvider {
  readonly name: string;
  /** False when API credentials are absent - the ONLY honest degradation signal. */
  isAvailable(): boolean;
  /** Live movers screener (meaningful for the current trading date only). Each side
   *  ordered by |percentChange| descending. */
  fetchRawMovers(): Promise<{ gainers: RawMover[]; losers: RawMover[] }>;
  /** Tradable-assets universe (active, allowed exchanges) - cached upstream. */
  fetchTradableAssetSymbols(): Promise<string[]>;
  /** Stage-1 screen snapshots for the given symbols. */
  fetchSnapshots(symbols: string[]): Promise<Map<string, SnapshotEvidence>>;
  /** Daily bars (consolidated) for the trading date: the date's bar and the latest
   *  prior bar, keyed by symbol. Symbols with no usable bars are absent. */
  fetchDailyBars(symbols: string[], tradingDate: string): Promise<Map<string, DailyBarEvidence>>;
  /** ADV in shares for the given symbols (stage-2 screen). */
  fetchAdvShares(symbols: string[]): Promise<Map<string, number>>;
}

export interface MoverScreenConfig {
  minPrice: number;
  maxPrice: number;
  minDollarVolume: number;
  maxSpreadBps: number;
  minAdvShares: number;
  fetchTopNPerSide: number;
  scanTopNPerSide: number;
}

export function defaultScreenConfig(): MoverScreenConfig {
  const c = continuousIntelligence;
  return {
    minPrice: c.broadUniverseMinPrice,
    maxPrice: c.broadUniverseMaxPrice,
    minDollarVolume: c.broadUniverseMinDollarVolume,
    maxSpreadBps: c.broadUniverseMaxSpreadBps,
    minAdvShares: c.broadUniverseMinAvgDailyVolumeShares,
    fetchTopNPerSide: c.moversFetchTopNPerSide,
    scanTopNPerSide: c.moversTopNPerScan,
  };
}

/** Screen rejection reasons - mirrors MarketUniverseScanner's ScreenRejectReason /
 *  ADV reject reasons for the benchmark's own investable screens. */
export type CohortScreenRejectReason =
  | 'NO_SNAPSHOT_DATA' | 'PRICE' | 'DOLLAR_VOLUME' | 'SPREAD_CROSSED' | 'SPREAD'
  | 'ADV_DATA_UNAVAILABLE' | 'ADV_BELOW_FLOOR';

/**
 * Pure investable-screen predicate. Mirrors MarketUniverseScanner.evaluateScreen()
 * (PRICE/DOLLAR_VOLUME/SPREAD_CROSSED/SPREAD, same config values) plus the ADV
 * stage (ADV_DATA_UNAVAILABLE/ADV_BELOW_FLOOR, same floor). The canonical gate
 * definitions live in MarketUniverseScanner.ts - if the funnel's gates change,
 * this mirror must be updated to match (see the config-key assertion in
 * moverCohort.test.ts).
 */
export function applyInvestableScreens(
  symbol: string,
  snap: SnapshotEvidence | undefined,
  advShares: number | null | undefined,
  cfg: MoverScreenConfig,
): { pass: boolean; reason: CohortScreenRejectReason | null } {
  if (!snap || snap.price == null || !(snap.price > 0)) return { pass: false, reason: 'NO_SNAPSHOT_DATA' };
  if (snap.price < cfg.minPrice || snap.price > cfg.maxPrice) return { pass: false, reason: 'PRICE' };
  if (snap.dollarVolume == null || !(snap.dollarVolume >= cfg.minDollarVolume)) return { pass: false, reason: 'DOLLAR_VOLUME' };
  if (snap.spreadCrossed) return { pass: false, reason: 'SPREAD_CROSSED' };
  if (snap.spreadBps != null && snap.spreadBps > cfg.maxSpreadBps) return { pass: false, reason: 'SPREAD' };
  if (advShares == null) return { pass: false, reason: 'ADV_DATA_UNAVAILABLE' };
  if (advShares < cfg.minAdvShares) return { pass: false, reason: 'ADV_BELOW_FLOOR' };
  return { pass: true, reason: null };
}

function nyTradingDate(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function shiftDay(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function insufficient(tradingDate: string, providerName: string, providerAvailable: boolean, reason: string): MoverCohortResult {
  return {
    tradingDate,
    members: [],
    insufficientEvidence: true,
    insufficientReason: reason,
    providerName,
    providerAvailable,
    universeSize: null,
    screenedOut: 0,
    fetchedAtIso: new Date().toISOString(),
  };
}

interface RankedCandidate {
  symbol: string;
  direction: MoverDirection;
  rank: number;
  eodMovePct: number | null;
  referencePrice: number | null;
  dayVolumeShares: number | null;
}

async function finalizeMembers(
  candidates: RankedCandidate[],
  provider: MoverDataProvider,
  universeSet: Set<string> | null,
  cfg: MoverScreenConfig,
  spreadScreened: boolean,
): Promise<{ members: MoverCohortMember[]; screenedOut: number }> {
  const symbols = candidates.map((c) => c.symbol);
  const snaps = await provider.fetchSnapshots(symbols);
  // Effective screen evidence per candidate. Same-date path: real snapshots only
  // (mirrors the funnel - a missing snapshot is NO_SNAPSHOT_DATA, not a fallback).
  // Past-date path: no quote snapshots can exist post-hoc, so bar-derived price +
  // dollar volume from the real daily bar is used and the spread screen is honestly
  // marked unavailable (spreadScreened: false on the member).
  const effective = new Map<string, SnapshotEvidence>();
  for (const c of candidates) {
    const s = snaps.get(c.symbol);
    if (s && s.price != null && s.price > 0) {
      effective.set(c.symbol, s);
      continue;
    }
    if (!spreadScreened && c.referencePrice != null && c.eodMovePct != null) {
      const close = c.referencePrice * (1 + c.eodMovePct / 100);
      effective.set(c.symbol, {
        symbol: c.symbol,
        price: close,
        dollarVolume: c.dayVolumeShares != null ? close * c.dayVolumeShares : null,
        spreadBps: null,
        spreadCrossed: false,
      });
    }
  }
  const advMap = await provider.fetchAdvShares([...effective.keys()]);
  const members: MoverCohortMember[] = [];
  let screenedOut = 0;
  for (const c of candidates) {
    const snapEv = effective.get(c.symbol);
    const adv = advMap.get(c.symbol) ?? null;
    const verdict = spreadScreened
      ? applyInvestableScreens(c.symbol, snapEv, adv, cfg)
      : applyBarScreens(snapEv, adv, cfg);
    if (!verdict.pass) {
      screenedOut += 1;
      continue;
    }
    members.push({
      symbol: c.symbol,
      direction: c.direction,
      eodMovePct: c.eodMovePct,
      referencePrice: c.referencePrice,
      dayVolumeShares: c.dayVolumeShares,
      screenerRank: c.rank,
      beyondScanCap: c.rank > cfg.scanTopNPerSide,
      inTradableUniverse: universeSet ? universeSet.has(c.symbol) : null,
      screenEvidence: {
        price: snapEv?.price ?? null,
        dollarVolume: snapEv?.dollarVolume ?? null,
        spreadBps: snapEv?.spreadBps ?? null,
        spreadCrossed: snapEv?.spreadCrossed ?? false,
        advShares: adv,
        spreadScreened,
      },
    });
  }
  return { members, screenedOut };
}

/**
 * Bar-derived screen for the past-date path: price + dollar-volume from the real
 * daily bar, then the same ADV stage. The spread screen is honestly not applicable
 * post-hoc (no quote exists for a past date) - recorded as spreadScreened: false
 * on the member rather than silently skipped.
 */
function applyBarScreens(
  snap: SnapshotEvidence | undefined,
  advShares: number | null,
  cfg: MoverScreenConfig,
): { pass: boolean; reason: CohortScreenRejectReason | null } {
  if (!snap || snap.price == null || !(snap.price > 0)) return { pass: false, reason: 'NO_SNAPSHOT_DATA' };
  if (snap.price < cfg.minPrice || snap.price > cfg.maxPrice) return { pass: false, reason: 'PRICE' };
  if (snap.dollarVolume == null || !(snap.dollarVolume >= cfg.minDollarVolume)) return { pass: false, reason: 'DOLLAR_VOLUME' };
  if (advShares == null) return { pass: false, reason: 'ADV_DATA_UNAVAILABLE' };
  if (advShares < cfg.minAdvShares) return { pass: false, reason: 'ADV_BELOW_FLOOR' };
  return { pass: true, reason: null };
}

/**
 * Same-trading-date path: the live movers screener defines the candidate set
 * (ordered by |percentChange|), snapshots + ADV apply the investable screens, and
 * real daily bars supply the benchmark eod_move_pct.
 */
async function buildSameDateCohort(
  tradingDate: string,
  provider: MoverDataProvider,
  cfg: MoverScreenConfig,
): Promise<MoverCohortResult> {
  const { gainers, losers } = await provider.fetchRawMovers();
  const bySide: Array<{ list: RawMover[]; direction: MoverDirection }> = [
    { list: gainers, direction: 'GAINER' },
    { list: losers, direction: 'LOSER' },
  ];
  const seen = new Set<string>();
  const ranked: Array<{ symbol: string; direction: MoverDirection; rank: number }> = [];
  for (const { list, direction } of bySide) {
    const ordered = [...list]
      .filter((m) => m.symbol && !seen.has(m.symbol))
      .sort((a, b) => Math.abs(b.percentChange ?? 0) - Math.abs(a.percentChange ?? 0))
      .slice(0, cfg.fetchTopNPerSide);
    ordered.forEach((m, i) => {
      seen.add(m.symbol);
      ranked.push({ symbol: m.symbol, direction, rank: i + 1 });
    });
  }
  if (ranked.length === 0) {
    return insufficient(tradingDate, provider.name, true, 'movers screener returned no usable symbols for the trading date');
  }
  const universe = await provider.fetchTradableAssetSymbols().catch((): string[] | null => null);
  const universeSet: Set<string> | null = universe ? new Set<string>(universe) : null;
  const bars = await provider.fetchDailyBars(ranked.map((r) => r.symbol), tradingDate);
  const candidates: RankedCandidate[] = ranked.map((r) => {
    const bar = bars.get(r.symbol);
    const eodMovePct = bar && bar.prevClose != null && bar.close != null && bar.prevClose > 0
      ? ((bar.close - bar.prevClose) / bar.prevClose) * 100
      : null;
    return { symbol: r.symbol, direction: r.direction, rank: r.rank, eodMovePct, referencePrice: bar?.prevClose ?? null, dayVolumeShares: bar?.volume ?? null };
  });
  const { members, screenedOut } = await finalizeMembers(candidates, provider, universeSet, cfg, true);
  return {
    tradingDate,
    members,
    insufficientEvidence: false,
    insufficientReason: null,
    providerName: provider.name,
    providerAvailable: true,
    universeSize: gainers.length + losers.length,
    screenedOut,
    fetchedAtIso: new Date().toISOString(),
  };
}

/**
 * Past-trading-date path (forward-validation backfill, e.g. 2026-10-05): the live
 * screener cannot serve a historical date, so the benchmark is recomputed from the
 * same provider's historical 1Day bars over the full tradable-assets universe. The
 * investable screens use the bar-derived price/dollar-volume plus the same ADV
 * stage; the spread screen is honestly unavailable post-hoc (spreadScreened:
 * false). Ranking is by |eodMovePct|.
 */
async function buildPastDateCohort(
  tradingDate: string,
  provider: MoverDataProvider,
  cfg: MoverScreenConfig,
): Promise<MoverCohortResult> {
  const universe = await provider.fetchTradableAssetSymbols();
  if (universe.length === 0) {
    return insufficient(tradingDate, provider.name, true, 'tradable-assets universe came back empty - cannot build a historical benchmark');
  }
  const bars = await provider.fetchDailyBars(universe, tradingDate);
  const computed: Array<{ symbol: string; eodMovePct: number; referencePrice: number; dayVolumeShares: number | null }> = [];
  for (const symbol of universe) {
    const bar = bars.get(symbol);
    if (!bar || bar.prevClose == null || bar.close == null || bar.prevClose <= 0 || bar.close <= 0) continue;
    computed.push({
      symbol,
      eodMovePct: ((bar.close - bar.prevClose) / bar.prevClose) * 100,
      referencePrice: bar.prevClose,
      dayVolumeShares: bar.volume,
    });
  }
  if (computed.length === 0) {
    return insufficient(tradingDate, provider.name, true, `no daily bars available for ${tradingDate} - cannot build an honest historical benchmark`);
  }
  const gainers = computed.filter((c) => c.eodMovePct >= 0).sort((a, b) => b.eodMovePct - a.eodMovePct).slice(0, cfg.fetchTopNPerSide);
  const losers = computed.filter((c) => c.eodMovePct < 0).sort((a, b) => a.eodMovePct - b.eodMovePct).slice(0, cfg.fetchTopNPerSide);
  const candidates: RankedCandidate[] = [
    ...gainers.map((c, i) => ({ ...c, direction: 'GAINER' as const, rank: i + 1 })),
    ...losers.map((c, i) => ({ ...c, direction: 'LOSER' as const, rank: i + 1 })),
  ];
  const { members, screenedOut } = await finalizeMembers(candidates, provider, new Set(universe), cfg, false);
  return {
    tradingDate,
    members,
    insufficientEvidence: false,
    insufficientReason: null,
    providerName: provider.name,
    providerAvailable: true,
    universeSize: universe.length,
    screenedOut,
    fetchedAtIso: new Date().toISOString(),
  };
}

/**
 * Real Alpaca provider. Lazy-imports MarketUniverseScanner's pieces so this module
 * stays side-effect-free at import time (the scanner module instantiates workers at
 * module scope). Uses the SAME screener endpoint + credentials + snapshot/ADV/bar
 * fetch shapes as the live movers funnel - this is reuse of the existing source,
 * not a parallel implementation.
 */
export function createAlpacaMoverProvider(): MoverDataProvider {
  const isAvailable = () => !!process.env.ALPACA_API_KEY && !!process.env.ALPACA_SECRET_KEY;
  return {
    name: 'alpaca',
    isAvailable,
    async fetchRawMovers() {
      // Same endpoint as MarketUniverseScanner.fetchTopMovers() - called directly
      // (rather than via fetchTopMovers()) because the benchmark needs per-side
      // ordering and percent_change, which that helper drops.
      const { networkEndpoints } = await import('../config/networkEndpoints');
      const { alpacaFetch } = await import('../core/alpacaTls');
      const { continuousIntelligence: ci } = await import('../config/continuousIntelligence');
      const { withDiscoveryCircuitBreaker } = await import('../core/discoveryHttpCircuitBreaker');
      const url = `${networkEndpoints.broker.alpaca.dataBaseUrl}/v1beta1/screener/stocks/movers?top=${ci.moversFetchTopNPerSide}`;
      const raw = await withDiscoveryCircuitBreaker('mover-cohort-screener', async () => {
        const res = await alpacaFetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`movers screener HTTP ${res.status}`);
        return (await res.json()) as { gainers?: Array<{ symbol?: string; percent_change?: number; price?: number }>; losers?: Array<{ symbol?: string; percent_change?: number; price?: number }> };
      });
      const parse = (rows: Array<{ symbol?: string; percent_change?: number; price?: number }> | undefined): RawMover[] =>
        (Array.isArray(rows) ? rows : [])
          .map((m) => ({
            symbol: String(m.symbol ?? '').trim().toUpperCase(),
            percentChange: typeof m.percent_change === 'number' ? m.percent_change : null,
            price: typeof m.price === 'number' ? m.price : null,
          }))
          .filter((m) => m.symbol.length > 0);
      return { gainers: parse(raw.gainers), losers: parse(raw.losers) };
    },
    async fetchTradableAssetSymbols() {
      const { fetchTradableAssets } = await import('../continuous/MarketUniverseScanner');
      return fetchTradableAssets();
    },
    async fetchSnapshots(symbols: string[]) {
      const { screenAssets } = await import('../continuous/MarketUniverseScanner');
      const snaps = await screenAssets(symbols);
      const out = new Map<string, SnapshotEvidence>();
      for (const s of snaps) {
        out.set(s.symbol, { symbol: s.symbol, price: s.price, dollarVolume: s.dollarVolume, spreadBps: s.spreadBps, spreadCrossed: s.spreadCrossed });
      }
      return out;
    },
    async fetchDailyBars(symbols: string[], tradingDate: string) {
      // Same multi-symbol 1Day bars shape as fetchAvgDailyVolumeShares (feed=sip =
      // consolidated volume). Fetches a small window around the trading date so the
      // date's bar AND the latest prior bar are both identifiable.
      const { networkEndpoints } = await import('../config/networkEndpoints');
      const { alpacaFetch } = await import('../core/alpacaTls');
      const { tradingWallTimeToIso } = await import('../core/TradingCalendar');
      const out = new Map<string, DailyBarEvidence>();
      const batchSize = 200;
      const startDay = shiftDay(tradingDate, -5);
      const endDay = shiftDay(tradingDate, 1);
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
          const url = new URL(`${networkEndpoints.broker.alpaca.dataBaseUrl}/v2/stocks/bars`);
          for (const [k, v] of Object.entries({
            symbols: batch.join(','), timeframe: '1Day', adjustment: 'raw', feed: 'sip',
            start: tradingWallTimeToIso(startDay, '00:00'), end: tradingWallTimeToIso(endDay, '00:00'),
            sort: 'desc', limit: '10',
          })) url.searchParams.set(k, v);
          const res = await alpacaFetch(url.toString(), { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`bars HTTP ${res.status}`);
          const raw = (await res.json()) as { bars?: Record<string, Array<{ t?: string; c?: number; v?: number }>> };
          for (const symbol of batch) {
            const bars = raw.bars?.[symbol];
            if (!Array.isArray(bars) || bars.length === 0) continue;
            const byDay = new Map<string, { c: number; v: number }>();
            for (const b of bars) {
              if (typeof b.t !== 'string' || typeof b.c !== 'number' || !(b.c > 0)) continue;
              const day = b.t.slice(0, 10);
              if (!byDay.has(day)) byDay.set(day, { c: b.c, v: typeof b.v === 'number' ? b.v : 0 });
            }
            const dayBar = byDay.get(tradingDate);
            if (!dayBar) continue; // no bar for the trading date itself - not a usable mover
            let prevClose: number | null = null;
            for (let back = 1; back <= 5 && prevClose == null; back += 1) {
              prevClose = byDay.get(shiftDay(tradingDate, -back))?.c ?? null;
            }
            out.set(symbol, { prevClose, close: dayBar.c, volume: dayBar.v });
          }
        } catch (e) {
          logErrorSafely('[moverCohort] daily bars batch failed', e);
        }
      }
      return out;
    },
    async fetchAdvShares(symbols: string[]) {
      const { fetchAvgDailyVolumeShares } = await import('../continuous/MarketUniverseScanner');
      return fetchAvgDailyVolumeShares(symbols);
    },
  };
}

/**
 * Builds the EOD benchmark mover cohort for a trading date (YYYY-MM-DD).
 * Pure orchestration over the injected provider - pass a fake provider in tests.
 */
export async function buildMoverCohort(
  tradingDate: string,
  opts?: { provider?: MoverDataProvider; screenConfig?: MoverScreenConfig; nowMs?: number },
): Promise<MoverCohortResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    throw new Error(`buildMoverCohort: invalid tradingDate '${tradingDate}' (expected YYYY-MM-DD)`);
  }
  const provider = opts?.provider ?? createAlpacaMoverProvider();
  const cfg = opts?.screenConfig ?? defaultScreenConfig();
  if (!provider.isAvailable()) {
    return insufficient(
      tradingDate, provider.name, false,
      'market-data provider unavailable (ALPACA_API_KEY/ALPACA_SECRET_KEY absent) - no synthetic movers fabricated',
    );
  }
  const today = nyTradingDate(opts?.nowMs ?? Date.now());
  try {
    if (tradingDate === today) {
      return await buildSameDateCohort(tradingDate, provider, cfg);
    }
    if (tradingDate > today) {
      return insufficient(tradingDate, provider.name, true, `tradingDate ${tradingDate} is in the future - no EOD data exists yet`);
    }
    return await buildPastDateCohort(tradingDate, provider, cfg);
  } catch (e) {
    logErrorSafely('[moverCohort] cohort build failed', e);
    return insufficient(tradingDate, provider.name, true, `provider error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
