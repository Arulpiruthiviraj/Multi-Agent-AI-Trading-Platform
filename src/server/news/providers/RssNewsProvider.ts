import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';
import Parser from 'rss-parser';
import { runtimeIntervals } from '../../config/runtimeIntervals';
import { networkEndpoints } from '../../config/networkEndpoints';

/** HTTP statuses that indicate the feed host is temporarily refusing us (log once, then skip). */
const RSS_TRANSIENT_HTTP = new Set([429, 502, 503, 504]);

export function rssHttpStatusFromError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const labeled = msg.match(/status code\s+(\d{3})/i);
  if (labeled) return Number(labeled[1]);
  const bare = msg.match(/\b(429|502|503|504)\b/);
  return bare ? Number(bare[1]) : null;
}

function isTransientRssFailure(err: unknown): boolean {
  const status = rssHttpStatusFromError(err);
  if (status !== null && RSS_TRANSIENT_HTTP.has(status)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timed?\s*out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i.test(msg);
}

export class RssNewsProvider implements NewsProviderPlugin {
  id: string;
  name: string;
  type = 'rss';
  credibilityWeight: number;
  private feedUrl: string;
  private parser: Parser;
  private backoffUntilMs = 0;
  private backoffLogged = false;

  constructor(
    id: string,
    name: string,
    feedUrl: string,
    credibilityWeight: number,
    parser?: Parser,
  ) {
    this.id = id;
    this.name = name;
    this.feedUrl = feedUrl;
    this.credibilityWeight = credibilityWeight;
    this.parser = parser ?? new Parser({
      timeout: runtimeIntervals.rssFeedFetchTimeoutMs,
      headers: {
        'User-Agent': networkEndpoints.newsRss.userAgent,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
  }

  async initialize() {}

  private inBackoff(nowMs: number = Date.now()): boolean {
    return this.backoffUntilMs > nowMs;
  }

  private enterBackoff(err: unknown): void {
    this.backoffUntilMs = Date.now() + runtimeIntervals.rssFeedErrorBackoffMs;
    if (this.backoffLogged) return;
    this.backoffLogged = true;
    const status = rssHttpStatusFromError(err);
    const detail = err instanceof Error ? err.message : String(err);
    const statusLabel = status !== null ? `HTTP ${status}` : 'fetch error';
    console.warn(
      `[RssNewsProvider] ${this.name} ${statusLabel} — backing off ${runtimeIntervals.rssFeedErrorBackoffMs / 1000}s: ${detail}`,
    );
  }

  private clearBackoff(): void {
    this.backoffUntilMs = 0;
    this.backoffLogged = false;
  }

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    const articles: NewsArticleRaw[] = [];
    if (this.inBackoff()) {
      return articles;
    }
    try {
      const feed = await this.parser.parseURL(this.feedUrl);
      this.clearBackoff();
      for (const item of feed.items) {
        articles.push({
          id: item.guid || item.link || String(Date.now()),
          title: item.title || '',
          content: item.contentSnippet || item.content || '',
          url: item.link || '',
          source: this.name,
          author: item.creator || this.name,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          symbols: [] // Will be extracted by the pipeline
        });
      }
    } catch (e) {
      if (isTransientRssFailure(e)) {
        this.enterBackoff(e);
      } else {
        const detail = e instanceof Error ? e.message : String(e);
        console.warn(`[RssNewsProvider] Failed to fetch feed ${this.name}: ${detail}`);
      }
    }
    return articles;
  }

  async healthCheck() {
    if (this.inBackoff()) return false;
    try {
      await this.parser.parseURL(this.feedUrl);
      this.clearBackoff();
      return true;
    } catch (e) {
      if (isTransientRssFailure(e)) this.enterBackoff(e);
      return false;
    }
  }
}
