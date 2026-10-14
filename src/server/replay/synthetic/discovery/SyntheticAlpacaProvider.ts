/**
 * SyntheticAlpacaProvider (2026-10-14) - serves the SyntheticDiscoveryMarket through the exact Alpaca REST shapes the production scanners already parse,
 * so the REAL MarketUniverseScanner / SnapshotScanner / OpportunityDiscovery run unmodified against a hidden-truth market. Installed through
 * `installSyntheticAlpacaProvider` (core/alpacaTls.ts), which exists only for synthetic/test processes. Everything the provider returns is derived from the
 * market's PUBLIC feed at the CURRENT simulated minute (no future data); hidden specs are never read. Any endpoint it does not implement is refused (503) and
 * recorded so a certification run can assert no unexpected provider traffic occurred.
 */
import type { SyntheticDiscoveryMarket } from './SyntheticDiscoveryMarket';

export interface SyntheticClock { minute(): number; nowMs(): number }

export class SyntheticAlpacaProviderImpl {
  readonly unsupported: string[] = [];
  readonly served: Record<string, number> = {};
  constructor(private readonly market: SyntheticDiscoveryMarket, private readonly clock: SyntheticClock, private readonly opts: { allowedExchange?: string; sessionDay?: string } = {}) {}

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  private count(k: string): void { this.served[k] = (this.served[k] ?? 0) + 1; }
  private day(): string { return this.opts.sessionDay ?? '2026-10-14'; }

  readonly fetch = async (url: string, _init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const minute = this.clock.minute();
    if (u.pathname === '/v2/assets') {
      this.count('assets');
      const ex = this.opts.allowedExchange ?? 'NASDAQ';
      return this.json(this.market.symbols.map((symbol) => ({ symbol, exchange: ex, status: 'active', tradable: true, class: 'us_equity' })));
    }
    if (u.pathname === '/v2/stocks/snapshots') {
      this.count('snapshots');
      const symbols = (u.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      const body: Record<string, unknown> = {};
      const tIso = new Date(this.clock.nowMs()).toISOString();
      for (const sym of symbols) {
        const snap = this.market.snapshot(sym, minute);
        if (!snap) continue;
        const spread = this.market.spreadBpsAt(sym, minute);
        const px = snap.latestTrade.p;
        const half = px * spread / 20000;
        body[sym] = {
          latestTrade: { p: px, t: tIso },
          latestQuote: { bp: +(px - half).toFixed(4), ap: +(px + half).toFixed(4) },
          dailyBar: { o: snap.dailyBar.o, c: snap.dailyBar.c, v: snap.dailyBar.v, h: Math.max(snap.dailyBar.o, px), l: Math.min(snap.dailyBar.o, px), t: `${this.day()}T04:00:00Z` },
          prevDailyBar: { c: snap.prevDailyBar.c, t: `${this.prevDay()}T04:00:00Z` },
        };
      }
      return this.json(body);
    }
    if (u.pathname === '/v2/stocks/bars') {
      this.count('bars');
      const symbols = (u.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      const bars: Record<string, unknown[]> = {};
      for (const sym of symbols) {
        const vols = this.market.priorDailyVolumes(sym, 24);
        bars[sym] = vols.map((v, i) => ({ t: `${this.tradingDayBack(i + 1)}T04:00:00Z`, v, o: 0, h: 0, l: 0, c: 0 }));
      }
      return this.json({ bars, next_page_token: null });
    }
    if (u.pathname === '/v1beta1/screener/stocks/movers') {
      this.count('movers');
      const top = Number(u.searchParams.get('top') ?? '20');
      const ranked = this.market.moversAt(minute, top * 2);
      const rows = ranked.map((symbol) => {
        const snap = this.market.snapshot(symbol, minute)!; const prev = snap.prevDailyBar.c; const price = snap.latestTrade.p;
        return { symbol, price, change: +(price - prev).toFixed(4), percent_change: +(((price / prev) - 1) * 100).toFixed(4) };
      });
      return this.json({ gainers: rows.filter((r) => r.change > 0).slice(0, top), losers: rows.filter((r) => r.change < 0).slice(0, top) });
    }
    this.unsupported.push(url);
    return new Response('SYNTHETIC_PROVIDER_UNSUPPORTED', { status: 503 });
  };

  /** Previous trading day (weekends skipped) relative to the session day. */
  private prevDay(): string { return this.tradingDayBack(1); }
  private tradingDayBack(n: number): string {
    const d = new Date(`${this.day()}T12:00:00Z`);
    let left = n;
    while (left > 0) { d.setUTCDate(d.getUTCDate() - 1); if (![0, 6].includes(d.getUTCDay())) left--; }
    return d.toISOString().slice(0, 10);
  }
}

export function createSyntheticAlpacaProvider(market: SyntheticDiscoveryMarket, clock: SyntheticClock, opts?: { allowedExchange?: string; sessionDay?: string }): SyntheticAlpacaProviderImpl {
  return new SyntheticAlpacaProviderImpl(market, clock, opts);
}
