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
  // Optional: reports whether the provider has the config (e.g. API key) it needs to fetch
  // anything at all. Absent = always configured (true), used by RSS providers that need no key.
  isConfigured?(): boolean;
}
