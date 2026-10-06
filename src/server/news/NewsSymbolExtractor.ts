import { NormalizedArticle } from './NewsNormalizer';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import {
  TICKER_NAMES,
  TICKERS_IN_LEXICON,
  AMBIGUOUS_TICKERS,
  COMMON_WORD_NAMES,
} from './tickerLexicon';

/**
 * Resolves ticker symbols mentioned in a news article, in priority order:
 *   1. Provider-supplied symbols (article.symbols) — kept as the highest-trust source.
 *   2. Explicit `$TICKER` markers — authorial intent, high confidence (shape-validated via
 *      looksLikeListedTicker; resolves even outside the lexicon).
 *   3. Company-name aliases from tickerLexicon.ts (e.g. "Apple" -> AAPL, "Google" -> GOOGL).
 *      Aliases that are common English words additionally require capitalization.
 *   4. Bare uppercase 2-5 char tokens (e.g. NVDA) checked against the lexicon.
 *
 * Ambiguity guard: bare tokens in AMBIGUOUS_TICKERS (CAT, AI, A, NOW, PATH, ...) are NEVER
 * accepted alone — they need extra evidence: an explicit $TICKER marker, a provider-supplied
 * symbol (both handled above), or a company-name alias of the same ticker within
 * EVIDENCE_WINDOW_WORDS words of the token. This prevents "the cat sat on the mat" from
 * attributing Caterpillar and "AI is transforming" from attributing C3.ai.
 *
 * Subsidiary/brand names are intentionally not mapped to parents (see tickerLexicon.ts):
 * an article about "Google acquiring a startup" attributes GOOGL via the acquirer's name,
 * and "startup" resolves to nothing — never a spurious ticker.
 */
const EXPLICIT_TICKER_RE = /\$([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b/g;
const BARE_TOKEN_RE = /\b[A-Z]{1,5}(?:\.[A-Z])?\b/g;
const WORD_RE = /\S+/g;
/** Words on either side of an ambiguous bare token scanned for a company-name alias. */
const EVIDENCE_WINDOW_WORDS = 40;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCapitalizedSpan(text: string, index: number): boolean {
  const ch = text[index];
  return ch !== undefined && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

interface WordSpan {
  word: string;
  start: number;
  end: number;
}

function wordSpans(text: string): WordSpan[] {
  const out: WordSpan[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** True when `name` matches in `text` with the capitalization rule applied. */
function findNameMatch(text: string, name: string): number {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text)) !== null) {
    if (COMMON_WORD_NAMES.has(name) && !isCapitalizedSpan(text, hit.index)) continue;
    return hit.index;
  }
  return -1;
}

export class NewsSymbolExtractor {
  public extract(article: NormalizedArticle): string[] {
    // 1. Provider-supplied symbols first (existing behavior — NewsEngine shape-filters after).
    // Provider symbols are kept verbatim; `seenUpper` only prevents this extractor's own
    // later stages from adding a case-duplicate of one.
    const extracted = new Set(article.symbols);
    const seenUpper = new Set(article.symbols.map((s) => s.toUpperCase()));
    const add = (ticker: string): void => {
      if (seenUpper.has(ticker.toUpperCase())) return;
      seenUpper.add(ticker.toUpperCase());
      extracted.add(ticker);
    };
    const text = `${article.title}\n${article.content}`;

    // 2. Explicit $TICKER markers — high confidence, resolve even outside the lexicon.
    EXPLICIT_TICKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPLICIT_TICKER_RE.exec(text)) !== null) {
      const ticker = looksLikeListedTicker(m[1]);
      if (ticker) add(ticker);
    }

    // 3. Company-name aliases -> ticker.
    for (const [ticker, names] of TICKER_NAMES) {
      if (seenUpper.has(ticker)) continue;
      for (const name of names) {
        if (findNameMatch(text, name) >= 0) {
          add(ticker);
          break;
        }
      }
    }

    // 4. Bare uppercase tokens checked against the lexicon (ambiguous ones need evidence).
    const spans = wordSpans(text);
    BARE_TOKEN_RE.lastIndex = 0;
    while ((m = BARE_TOKEN_RE.exec(text)) !== null) {
      const token = m[0];
      if (seenUpper.has(token)) continue;
      if (!TICKERS_IN_LEXICON.has(token)) continue;
      if (AMBIGUOUS_TICKERS.has(token)) {
        if (!this.hasNearbyCompanyName(text, spans, m.index, token)) continue;
      }
      add(token);
    }

    return Array.from(extracted);
  }

  /**
   * Extra-evidence rule for ambiguous bare tokens: a company-name alias of the same ticker
   * must appear within EVIDENCE_WINDOW_WORDS words of the token's position.
   */
  private hasNearbyCompanyName(
    text: string,
    spans: WordSpan[],
    tokenCharIndex: number,
    ticker: string,
  ): boolean {
    let wordIndex = spans.findIndex((s) => tokenCharIndex >= s.start && tokenCharIndex < s.end);
    if (wordIndex < 0) wordIndex = 0;
    const lo = Math.max(0, wordIndex - EVIDENCE_WINDOW_WORDS);
    const hi = Math.min(spans.length, wordIndex + EVIDENCE_WINDOW_WORDS + 1);
    if (lo >= hi) return false;
    const windowStart = spans[lo].start;
    const windowText = text.slice(windowStart, spans[hi - 1].end);
    const names = TICKER_NAMES.get(ticker) ?? [];
    for (const name of names) {
      const relIndex = findNameMatch(windowText, name);
      if (relIndex < 0) continue;
      return true;
    }
    return false;
  }
}
