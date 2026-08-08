export interface NewsArticleRaw {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  author: string;
  publishedAt: string;
  symbols: string[];
}

export interface NewsProviderPlugin {
  id: string;
  name: string;
  type: string;
  credibilityWeight: number;
  initialize(): Promise<void>;
  fetchLatest(): Promise<NewsArticleRaw[]>;
  healthCheck(): Promise<boolean>;
}
