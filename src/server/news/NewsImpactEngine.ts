import { NormalizedArticle } from './NewsNormalizer';

export interface ImpactAssessment {
  sentiment: number; // -1 to 1
  impactScore: number; // 0 to 1
  timeHorizon: string; // Immediate, Intraday, Swing, Long Term
}

export class NewsImpactEngine {
  public assess(article: NormalizedArticle, category: string): ImpactAssessment {
    const text = `${article.title} ${article.content}`.toLowerCase();
    
    let sentiment = 0;
    if (text.match(/surge|beat|record|growth|upgrade|soar/)) sentiment += 0.6;
    if (text.match(/plunge|miss|decline|downgrade|drop|fall/)) sentiment -= 0.6;
    
    let impactScore = 0.5;
    if (category === 'Earnings' || category === 'M&A') impactScore = 0.9;
    if (category === 'Macro') impactScore = 0.8;
    
    let timeHorizon = 'Intraday';
    if (category === 'Macro' || category === 'M&A') timeHorizon = 'Swing';
    
    return {
      sentiment: Math.max(-1, Math.min(1, sentiment)),
      impactScore,
      timeHorizon
    };
  }
}
