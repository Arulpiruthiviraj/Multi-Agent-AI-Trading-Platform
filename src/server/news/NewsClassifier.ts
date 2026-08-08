import { NormalizedArticle } from './NewsNormalizer';

export class NewsClassifier {
  public classify(article: NormalizedArticle): string {
    const text = `${article.title} ${article.content}`.toLowerCase();
    if (text.includes('earnings') || text.includes('revenue') || text.includes('eps')) return 'Earnings';
    if (text.includes('dividend')) return 'Dividend';
    if (text.includes('merger') || text.includes('acquisition')) return 'M&A';
    if (text.includes('inflation') || text.includes('cpi')) return 'Macro';
    if (text.includes('lawsuit') || text.includes('sues')) return 'Legal';
    if (text.includes('ai') || text.includes('artificial intelligence')) return 'Technology';
    return 'General';
  }
}
