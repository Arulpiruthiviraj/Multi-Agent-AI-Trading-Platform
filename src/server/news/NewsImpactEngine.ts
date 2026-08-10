import { NormalizedArticle } from './NewsNormalizer';
import { getFinBertSentiment } from '../ai/LocalSentiment';

export interface ImpactAssessment {
  sentiment: number; // -1 to 1
  impactScore: number; // 0 to 1
  timeHorizon: string; // Immediate, Intraday, Swing, Long Term
  sentimentSource: 'finbert' | 'keyword-heuristic';
}

// Crude keyword-count heuristic - kept only as the fallback for when the local FinBERT
// service (npm run ai:serve) isn't running. Not used when a real model score is available.
function keywordSentiment(text: string): number {
  let sentiment = 0;
  if (text.match(/surge|beat|record|growth|upgrade|soar/)) sentiment += 0.6;
  if (text.match(/plunge|miss|decline|downgrade|drop|fall/)) sentiment -= 0.6;
  return Math.max(-1, Math.min(1, sentiment));
}

export class NewsImpactEngine {
  public async assess(article: NormalizedArticle, category: string): Promise<ImpactAssessment> {
    const text = `${article.title} ${article.content}`;

    const finbert = await getFinBertSentiment(text);
    const sentiment = finbert ? finbert.signedScore : keywordSentiment(text.toLowerCase());
    const sentimentSource: ImpactAssessment['sentimentSource'] = finbert ? 'finbert' : 'keyword-heuristic';

    let impactScore = 0.5;
    if (category === 'Earnings' || category === 'M&A') impactScore = 0.9;
    if (category === 'Macro') impactScore = 0.8;

    let timeHorizon = 'Intraday';
    if (category === 'Macro' || category === 'M&A') timeHorizon = 'Swing';

    return {
      sentiment,
      impactScore,
      timeHorizon,
      sentimentSource
    };
  }
}
