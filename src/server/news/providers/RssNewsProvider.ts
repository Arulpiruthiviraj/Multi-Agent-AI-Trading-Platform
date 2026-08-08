import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';
import Parser from 'rss-parser';

export class RssNewsProvider implements NewsProviderPlugin {
  id: string;
  name: string;
  type = 'rss';
  credibilityWeight: number;
  private feedUrl: string;
  private parser: Parser;

  constructor(id: string, name: string, feedUrl: string, credibilityWeight: number) {
    this.id = id;
    this.name = name;
    this.feedUrl = feedUrl;
    this.credibilityWeight = credibilityWeight;
    this.parser = new Parser();
  }

  async initialize() {}
  
  async fetchLatest(): Promise<NewsArticleRaw[]> {
    const articles: NewsArticleRaw[] = [];
    try {
      const feed = await this.parser.parseURL(this.feedUrl);
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
      console.error(`[RssNewsProvider] Failed to fetch feed ${this.name}:`, e);
    }
    return articles;
  }

  async healthCheck() {
    try {
      await this.parser.parseURL(this.feedUrl);
      return true;
    } catch (e) {
      return false;
    }
  }
}
