import { NormalizedArticle } from './NewsNormalizer';

export class NewsSymbolExtractor {
  public extract(article: NormalizedArticle): string[] {
    const extracted = new Set(article.symbols);
    
    // Basic extraction heuristic
    const commonTickers = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META'];
    const words = `${article.title} ${article.content}`.split(/\W+/);
    
    for (const word of words) {
      if (word === word.toUpperCase() && word.length >= 2 && word.length <= 5 && commonTickers.includes(word)) {
        extracted.add(word);
      }
    }
    
    return Array.from(extracted);
  }
}
