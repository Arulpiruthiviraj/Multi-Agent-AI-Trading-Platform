import { NewsProviderPlugin, NewsArticleRaw } from './NewsProviderPlugin';

export class MockNewsProvider implements NewsProviderPlugin {
  id = 'mock_news';
  name = 'Mock News API';
  type = 'mock';
  credibilityWeight = 0.5;

  async initialize() {}
  
  async fetchLatest(): Promise<NewsArticleRaw[]> {
    return [
      {
        id: `mock_${Date.now()}`,
        title: "Apple Announces New AI Strategy",
        content: "Apple has unveiled its latest approach to artificial intelligence, focusing on on-device processing and privacy.",
        url: "https://example.com/apple-ai",
        source: "Mock News API",
        author: "John Doe",
        publishedAt: new Date().toISOString(),
        symbols: ["AAPL"]
      }
    ];
  }

  async healthCheck() { return true; }
}
