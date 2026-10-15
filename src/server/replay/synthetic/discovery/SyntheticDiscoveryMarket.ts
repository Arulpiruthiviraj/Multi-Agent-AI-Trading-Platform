/**
 * SyntheticDiscoveryMarket - a large hidden-ground-truth market for UNIVERSAL DISCOVERY certification (2026-10-14).
 * Evidence class SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY.
 *
 * The market publishes ONLY what a real market data feed would: per-symbol snapshots (minute bar, cumulative daily bar, previous daily bar,
 * last trade), a top-movers list derived from the published prices, and a static broad-universe liquidity list. Which symbols carry a hidden
 * opportunity, trap or nothing at all is held in `groundTruth()` - that accessor exists ONLY for the independent OpportunityOracle and the
 * harness; production discovery code must never import this module (asserted by a static scan in the certification test).
 *
 * Deterministic from `seed`. Tickers are letter-only (looksLikeListedTicker requires 1-5 letters).
 */
import { SyntheticRandom } from '../SyntheticRandom';

export const SESSION_MINUTES = 390;

export type ValidKind = 'CERTIFIED_PATH' | 'MOMENTUM_BREAKOUT' | 'GAP_AND_GO' | 'HIGH_VOLUME_MOVER' | 'CONTINUATION' | 'MEAN_REVERSION';
export type TrapKind = 'FALSE_BREAKOUT' | 'LOW_LIQUIDITY_SPIKE' | 'TINY_VOLUME_HUGE_PCT' | 'STALE_DATA';

export interface HiddenSpec {
  symbol: string;
  cls: 'VALID' | 'TRAP';
  kind: ValidKind | TrapKind;
  startMin: number;
  durationMin: number;
  strength: number; // 0..1, scales the move / volume
  insideStartingWatchlist: boolean;
}

export interface DiscoveryMarketConfig {
  seed: number;
  universeSize: number;
  startingWatchlistSize: number;
  validCount: number;
  trapCount: number;
  /** fraction of valid opportunities placed OUTSIDE the starting watchlist (1 = all of them: the "watchlist is boring" variant) */
  outsideFraction: number;
  /** Exit-path fixture (default off): after a VALID opportunity window ends the price decays at this per-minute drift for `reversalMinutes`, so a position
   *  opened on the opportunity meets a real adverse move (protective exit / stop path). Environment control only - the decision to exit is Argus's. */
  postWindowReversal?: { driftPerMin: number; minutes: number };
  /** Number of VALID opportunities generated with the multi-phase CERTIFIED_PATH shape (breakout -> continuation -> reversal) that the proven positive
   *  scenarios (CERTIFIED_BULLISH_ENTRY_EXIT) use, so the CORE strategies' own trigger/EV filters can legitimately fire. Default 0 (baseline unchanged). */
  certifiedPathCount?: number;
}

export interface RawSnapshot {
  minuteBar: { c: number; h: number; l: number; v: number };
  dailyBar: { o: number; c: number; v: number };
  prevDailyBar: { c: number; v: number };
  latestTrade: { p: number };
}

interface SymbolSeries { open: number; close: number[]; high: number[]; low: number[]; vol: number[]; cumVol: number[]; prevClose: number; prevVol: number }

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function syntheticTicker(i: number): string {
  // 4 letters, first letter 'Z' reserved-free: spread across the alphabet so tickers do not collide with real mega-caps used elsewhere
  const a = ALPHA[(Math.floor(i / 17576) + 11) % 26];
  const b = ALPHA[Math.floor(i / 676) % 26];
  const c = ALPHA[Math.floor(i / 26) % 26];
  const d = ALPHA[i % 26];
  return `${a}${b}${c}${d}`;
}

export class SyntheticDiscoveryMarket {
  readonly symbols: string[];
  readonly startingWatchlist: string[];
  private readonly series = new Map<string, SymbolSeries>();
  private readonly specs: HiddenSpec[] = [];

  constructor(readonly cfg: DiscoveryMarketConfig) {
    const rng = new SyntheticRandom(cfg.seed);
    this.symbols = Array.from({ length: cfg.universeSize }, (_, i) => syntheticTicker(i));
    // deterministic shuffle -> starting watchlist is a random subset (Argus's configured list), not "the first N"
    const order = [...this.symbols].sort(() => rng.next() - 0.5);
    this.startingWatchlist = order.slice(0, cfg.startingWatchlistSize);
    const inside = new Set(this.startingWatchlist);
    const outside = this.symbols.filter((s) => !inside.has(s));
    const insideList = this.startingWatchlist;

    const pick = (pool: string[], used: Set<string>) => {
      for (let t = 0; t < 1000; t++) {
        const s = pool[Math.floor(rng.next() * pool.length)];
        if (!used.has(s)) { used.add(s); return s; }
      }
      throw new Error('universe too small for the requested opportunity count');
    };
    const used = new Set<string>();
    const kinds: ValidKind[] = ['MOMENTUM_BREAKOUT', 'GAP_AND_GO', 'HIGH_VOLUME_MOVER', 'CONTINUATION', 'MEAN_REVERSION'];
    for (let i = 0; i < cfg.validCount; i++) {
      const kind: ValidKind = i < (cfg.certifiedPathCount ?? 0) ? 'CERTIFIED_PATH' : kinds[i % kinds.length];
      const isOutside = rng.next() < cfg.outsideFraction;
      const symbol = pick(isOutside ? outside : insideList, used);
      const start = kind === 'GAP_AND_GO' ? 0 : kind === 'CERTIFIED_PATH' ? Math.floor(rng.range(20, 120)) : Math.floor(rng.range(15, 230));
      this.specs.push({ symbol, cls: 'VALID', kind, startMin: start, durationMin: kind === 'CERTIFIED_PATH' ? 75 : Math.floor(rng.range(35, 70)), strength: +rng.range(0.55, 1).toFixed(2), insideStartingWatchlist: !isOutside });
    }
    const trapKinds: TrapKind[] = ['FALSE_BREAKOUT', 'LOW_LIQUIDITY_SPIKE', 'TINY_VOLUME_HUGE_PCT', 'STALE_DATA'];
    for (let i = 0; i < cfg.trapCount; i++) {
      const isOutside = rng.next() < 0.5;
      const symbol = pick(isOutside ? outside : insideList, used);
      this.specs.push({ symbol, cls: 'TRAP', kind: trapKinds[i % trapKinds.length], startMin: Math.floor(rng.range(15, 230)), durationMin: Math.floor(rng.range(25, 50)), strength: +rng.range(0.6, 1).toFixed(2), insideStartingWatchlist: !isOutside });
    }
    const specBySymbol = new Map(this.specs.map((s) => [s.symbol, s]));
    for (const sym of this.symbols) this.series.set(sym, this.buildSeries(sym, specBySymbol.get(sym), new SyntheticRandom(cfg.seed * 7919 + this.symbols.indexOf(sym) * 31 + 1)));
  }

  private buildSeries(symbol: string, spec: HiddenSpec | undefined, rng: SyntheticRandom): SymbolSeries {
    void symbol;
    const prevClose = +rng.range(12, 520).toFixed(2);
    const prevVol = Math.round(rng.range(1.2e6, 28e6)); // liquid enough for the broad-universe screen
    const baseMinVol = prevVol / SESSION_MINUTES;
    const gap = spec?.kind === 'GAP_AND_GO' ? 0.035 + 0.03 * spec.strength : rng.range(-0.004, 0.004);
    const open = +(prevClose * (1 + gap)).toFixed(2);
    const close: number[] = []; const high: number[] = []; const low: number[] = []; const vol: number[] = []; const cumVol: number[] = [];
    let px = open; let cum = 0;
    const sigma = 0.0007;
    const tinyLiq = spec?.kind === 'LOW_LIQUIDITY_SPIKE' || spec?.kind === 'TINY_VOLUME_HUGE_PCT';
    for (let m = 0; m < SESSION_MINUTES; m++) {
      let drift = 0; let volMult = 1;
      if (spec) {
        const rel = m - spec.startMin; const inWin = rel >= 0 && rel < spec.durationMin;
        const k = spec.strength;
        switch (spec.kind) {
          case 'CERTIFIED_PATH': {
            // breakout (0-15) -> continuation (15-75 = window end) -> reversal (75-155). Shape follows CERTIFIED_BULLISH_ENTRY_EXIT's D/E/F phases, time-compressed.
            if (rel >= 0 && rel < 15) { drift = 0.0022 * k; volMult = 4 + 2.5 * k; }
            else if (rel >= 15 && rel < 75) { drift = 0.0007 * k; volMult = 2.2 + 1.2 * k; }
            else if (rel >= 75 && rel < 155) { drift = -0.0012; volMult = 1.8; }
            break;
          }
          case 'MOMENTUM_BREAKOUT': if (inWin) { drift = rel < 25 ? 0.0024 * k : 0.0004 * k; volMult = 3 + 3 * k; } break;
          case 'GAP_AND_GO': if (m < spec.durationMin) { drift = 0.0006 * k; volMult = 3 + 2 * k; } break;
          case 'HIGH_VOLUME_MOVER': if (inWin) { drift = rel < 15 ? 0.0022 * k : 0.0002; volMult = 6 + 4 * k; } break;
          case 'CONTINUATION': if (inWin) { drift = (rel % 12 < 8) ? 0.0013 * k : -0.0004 * k; volMult = 2.4 + 1.5 * k; } break;
          case 'MEAN_REVERSION': if (inWin) { drift = rel < 14 ? -0.0042 * k : 0.0009 * k; volMult = 2.5 + 2 * k; } break;
          case 'FALSE_BREAKOUT': if (inWin) { drift = rel < 10 ? 0.005 * k : -0.0042 * k; volMult = 4 + 2 * k; } break;
          case 'LOW_LIQUIDITY_SPIKE': if (inWin) { drift = rel < 8 ? 0.012 * k : 0; volMult = 0.04; } break;
          case 'TINY_VOLUME_HUGE_PCT': if (inWin) { drift = rel < 6 ? 0.02 * k : 0; volMult = 0.02; } break;
          case 'STALE_DATA': break; // handled below: published data freezes while a big apparent move exists
        }
      }
      if (spec && spec.cls === 'VALID' && spec.kind !== 'CERTIFIED_PATH' && this.cfg.postWindowReversal) {
        const after = m - (spec.startMin + spec.durationMin);
        if (after >= 0 && after < this.cfg.postWindowReversal.minutes) drift = this.cfg.postWindowReversal.driftPerMin;
      }
      const ret = drift + sigma * rng.gaussian();
      const nxt = Math.max(1, px * (1 + ret));
      const h = Math.max(px, nxt) * (1 + Math.abs(sigma * rng.gaussian()) * 0.6);
      const l = Math.min(px, nxt) * (1 - Math.abs(sigma * rng.gaussian()) * 0.6);
      let v = Math.max(1, Math.round(baseMinVol * volMult * rng.range(0.7, 1.4)));
      if (tinyLiq && spec && m >= spec.startMin && m < spec.startMin + spec.durationMin) v = Math.max(1, Math.round(baseMinVol * volMult));
      cum += v;
      close.push(+nxt.toFixed(2)); high.push(+h.toFixed(2)); low.push(+l.toFixed(2)); vol.push(v); cumVol.push(cum);
      px = nxt;
    }
    if (spec?.kind === 'STALE_DATA') {
      // the published feed shows a large move from startMin and then NEVER updates again (a stuck quote): no volume, no change
      const freezeAt = spec.startMin; const stuckPx = +(close[freezeAt] * 1.07).toFixed(2);
      for (let m = freezeAt; m < SESSION_MINUTES; m++) { close[m] = stuckPx; high[m] = stuckPx; low[m] = stuckPx; vol[m] = 0; cumVol[m] = cumVol[freezeAt - 1] ?? 0; }
    }
    return { open, close, high, low, vol, cumVol, prevClose, prevVol };
  }

  // ---------------- public data feed (what Argus is allowed to see) ----------------

  snapshot(symbol: string, minute: number): RawSnapshot | undefined {
    const s = this.series.get(symbol);
    if (!s || minute < 0) return undefined;
    const m = Math.min(minute, SESSION_MINUTES - 1);
    return {
      minuteBar: { c: s.close[m], h: s.high[m], l: s.low[m], v: s.vol[m] },
      dailyBar: { o: s.open, c: s.close[m], v: s.cumVol[m] },
      prevDailyBar: { c: s.prevClose, v: s.prevVol },
      latestTrade: { p: s.close[m] },
    };
  }

  /** Top gainers/losers by published % change among symbols with real dollar volume (the shape a screened movers feed has). */
  moversAt(minute: number, n: number, minDollarVolume = 2_000_000): string[] {
    const rows: Array<{ symbol: string; absPct: number }> = [];
    for (const sym of this.symbols) {
      const s = this.series.get(sym)!; const m = Math.min(minute, SESSION_MINUTES - 1);
      const dollar = s.cumVol[m] * s.close[m];
      if (dollar < minDollarVolume) continue;
      rows.push({ symbol: sym, absPct: Math.abs(s.close[m] / s.prevClose - 1) });
    }
    return rows.sort((a, b) => b.absPct - a.absPct).slice(0, n).map((r) => r.symbol);
  }

  /** Same-session move of a symbol as the broad scanner would have measured it at `minute` (current price vs the day's open, a fraction). */
  sessionMoveAt(symbol: string, minute: number): number | null {
    const s = this.series.get(symbol); if (!s || minute < 0) return null;
    const m = Math.min(minute, SESSION_MINUTES - 1);
    return s.close[m] / s.open - 1;
  }

  /** Liquidity list (previous-day dollar volume), descending - what an ADV screen produces. gapPct is the same-session move as of the LAST broad refresh
   *  (`asOfMinute`); the harness passes the 15-minute refresh boundary, so the evidence ages exactly like production's. */
  broadUniverse(asOfMinute = 0): Array<{ symbol: string; dollarVolume: number; gapPct: number | null }> {
    return this.symbols.map((symbol) => {
      const s = this.series.get(symbol)!;
      return { symbol, dollarVolume: s.prevVol * s.prevClose, gapPct: this.sessionMoveAt(symbol, asOfMinute) };
    }).sort((a, b) => b.dollarVolume - a.dollarVolume);
  }

  /** Published quote spread (bps) at `minute` - the PUBLIC feed. Liquid names are tight; thin/stale traps quote wide (what makes them traps). */
  spreadBpsAt(symbol: string, minute: number): number {
    const idx = this.symbols.indexOf(symbol);
    const base = 3 + ((idx * 2654435761) % 10); // deterministic 3..12 bps
    const spec = this.specs.find((x) => x.symbol === symbol);
    if (!spec) return base;
    const inWin = minute >= spec.startMin && minute < spec.startMin + spec.durationMin;
    if ((spec.kind === 'LOW_LIQUIDITY_SPIKE' || spec.kind === 'TINY_VOLUME_HUGE_PCT') && inWin) return 140;
    if (spec.kind === 'STALE_DATA' && minute >= spec.startMin) return 90;
    if (spec.kind === 'GAP_AND_GO' && minute < 10) return base + 18;
    return base;
  }

  /** Completed prior daily volumes (newest first) for ADV screens: prevVol with deterministic day-to-day variation. Never includes today. */
  priorDailyVolumes(symbol: string, days: number): number[] {
    const s = this.series.get(symbol); if (!s) return [];
    const idx = this.symbols.indexOf(symbol);
    return Array.from({ length: days }, (_, d) => Math.max(1, Math.round(s.prevVol * (0.8 + (((idx * 31 + d * 17) % 40) / 100)))));
  }

  /** Previous session close and today's open (public). */
  prevCloseOf(symbol: string): number | undefined { return this.series.get(symbol)?.prevClose; }
  openOf(symbol: string): number | undefined { return this.series.get(symbol)?.open; }

  // ---------------- ground truth: ORACLE / HARNESS ONLY ----------------

  /** Hidden specs. Production discovery code must never call or import this. */
  groundTruth(): readonly HiddenSpec[] { return this.specs; }

  /** Raw bars for the oracle's own independent computations. */
  barsForOracle(symbol: string): SymbolSeries { return this.series.get(symbol)!; }
}
