/**
 * Ticker lexicon for NewsSymbolExtractor (workstream C, 2026-10-06).
 *
 * What this is: a CURATED, hand-reviewed map from the repo's own configured scan universes
 * (config/continuousIntelligence.json: momentumScanUniverseSymbols + core/protected/seed/watch
 * universes — 122 tickers) plus 5 curated large caps (A, ARE, C, IT, ON — added ONLY as
 * stoplisted ambiguous entries, see below) to canonical company-name aliases, plus a
 * stoplist of tickers that collide with common English words. 127 tickers total.
 *
 * COVERAGE LIMITS (honest, by design):
 * 1. Only these 127 tickers are resolvable by bare token or company name. A mid/small-cap
 *    outside this list is NEVER guessed from prose —
 *    it resolves only via an explicit `$TICKER` marker or a provider-supplied symbol.
 * 2. Company-name aliases cover large, frequently-reported companies. Subsidiary/brand names
 *    are intentionally NOT mapped to the parent (e.g. "YouTube" does not resolve to GOOGL)
 *    to avoid misattribution — an article about a subsidiary is about the subsidiary.
 *    The one documented exception is a former corporate name kept ONLY where the rename is
 *    recent and news copy still uses it ("Facebook" -> META); stale names that would
 *    mis-resolve (e.g. "Square" -> XYZ, renamed 2023) are deliberately excluded.
 * 3. This is news-plumbing/orchestration (text -> ticker attribution), not quant math —
 *    no indicator, signal, or strategy calculation lives here (Java Engine Authority).
 * 4. The lexicon is static and curated, not a live ticker database: newly listed tickers,
 *    ticker changes, and delistings are NOT picked up until this file is updated.
 *
 * AMBIGUITY RULE (enforced by NewsSymbolExtractor, not here): tickers in AMBIGUOUS_TICKERS
 * are common English words (or single letters) and are NEVER accepted from a bare token
 * alone — they require extra evidence: an explicit `$TICKER` marker, a provider-supplied
 * symbol, or a company-name alias of the same ticker nearby in the text.
 */
export interface TickerLexiconEntry {
  ticker: string;
  /** Lowercase canonical company-name aliases for this ticker. */
  names: string[];
}

/**
 * Ticker -> company-name aliases. Aliases are matched case-insensitively on word boundaries;
 * aliases listed in COMMON_WORD_NAMES additionally require the matched span to be capitalized
 * in the source text (they are common nouns/verbs when lowercase).
 */
export const TICKER_LEXICON: TickerLexiconEntry[] = [
  // Curated large-cap additions BEYOND the config universes (2026-10-06, workstream C):
  // these five are all large-cap names whose tickers collide with common English words,
  // so they exist here ONLY as stoplisted entries — they can never be accepted from a bare
  // token alone (see AMBIGUOUS_TICKERS), only via $TICKER, provider symbol, or company name.
  { ticker: 'A', names: ['agilent', 'agilent technologies'] },
  { ticker: 'ARE', names: ['alexandria real estate', 'alexandria'] },
  { ticker: 'C', names: ['citigroup', 'citi'] },
  { ticker: 'IT', names: ['gartner'] },
  { ticker: 'ON', names: ['on semiconductor', 'onsemi'] },
  { ticker: 'AAL', names: ['american airlines'] },
  { ticker: 'AAPL', names: ['apple'] },
  { ticker: 'ABBV', names: ['abbvie'] },
  { ticker: 'ABNB', names: ['airbnb'] },
  { ticker: 'ABT', names: ['abbott', 'abbott laboratories'] },
  { ticker: 'ACN', names: ['accenture'] },
  { ticker: 'ADBE', names: ['adobe'] },
  { ticker: 'AI', names: ['c3.ai', 'c3 ai'] },
  { ticker: 'AMAT', names: ['applied materials'] },
  { ticker: 'AMD', names: ['advanced micro devices'] },
  { ticker: 'AMZN', names: ['amazon'] },
  { ticker: 'ARM', names: ['arm holdings', 'arm'] },
  { ticker: 'ASML', names: ['asml'] },
  { ticker: 'AVGO', names: ['broadcom'] },
  { ticker: 'AXP', names: ['american express', 'amex'] },
  { ticker: 'BA', names: ['boeing'] },
  { ticker: 'BAC', names: ['bank of america'] },
  { ticker: 'BKNG', names: ['booking holdings', 'booking.com'] },
  { ticker: 'BLK', names: ['blackrock'] },
  { ticker: 'BRK.B', names: ['berkshire hathaway', 'berkshire'] },
  { ticker: 'CAT', names: ['caterpillar'] },
  { ticker: 'CMCSA', names: ['comcast'] },
  { ticker: 'COIN', names: ['coinbase'] },
  { ticker: 'COST', names: ['costco'] },
  { ticker: 'CRM', names: ['salesforce'] },
  { ticker: 'CRWD', names: ['crowdstrike'] },
  { ticker: 'CSCO', names: ['cisco'] },
  { ticker: 'CSX', names: ['csx'] },
  { ticker: 'CVX', names: ['chevron'] },
  { ticker: 'DAL', names: ['delta air lines', 'delta'] },
  { ticker: 'DDOG', names: ['datadog'] },
  { ticker: 'DELL', names: ['dell'] },
  // DIA/SPY/QQQ/IWM/GLD/SMH/XLF/XLE/XLK/SOXL/TQQQ/SQQQ are ETFs — no company-name aliases;
  // they resolve via bare token or $TICKER only.
  { ticker: 'DIS', names: ['disney', 'walt disney'] },
  { ticker: 'F', names: ['ford'] },
  { ticker: 'FDX', names: ['fedex'] },
  { ticker: 'GE', names: ['ge aerospace', 'general electric'] },
  { ticker: 'GM', names: ['general motors'] },
  // "google"/"alphabet" resolve to GOOGL (primary Class C listing) only — attributing both
  // share classes from one company-name mention would double-count every Alphabet catalyst.
  // GOOG still resolves via bare token, $GOOG, or provider symbol.
  { ticker: 'GOOG', names: [] },
  { ticker: 'GOOGL', names: ['alphabet', 'google'] },
  { ticker: 'GS', names: ['goldman sachs', 'goldman'] },
  { ticker: 'HD', names: ['home depot'] },
  { ticker: 'HOOD', names: ['robinhood'] },
  { ticker: 'HPE', names: ['hewlett packard enterprise'] },
  { ticker: 'IBM', names: ['ibm'] },
  { ticker: 'INTC', names: ['intel'] },
  { ticker: 'INTU', names: ['intuit'] },
  { ticker: 'ISRG', names: ['intuitive surgical'] },
  { ticker: 'JNJ', names: ['johnson & johnson', 'johnson and johnson'] },
  { ticker: 'JPM', names: ['jpmorgan', 'jpmorgan chase'] },
  { ticker: 'KLAC', names: ['kla'] },
  { ticker: 'KO', names: ['coca-cola', 'coca cola'] },
  { ticker: 'LCID', names: ['lucid'] },
  { ticker: 'LIN', names: ['linde'] },
  { ticker: 'LLY', names: ['eli lilly', 'lilly'] },
  { ticker: 'LRCX', names: ['lam research'] },
  { ticker: 'MA', names: ['mastercard'] },
  { ticker: 'MARA', names: ['marathon digital', 'marathon'] },
  { ticker: 'MCD', names: ["mcdonald's", 'mcdonalds'] },
  { ticker: 'MDB', names: ['mongodb'] },
  { ticker: 'META', names: ['meta', 'facebook'] },
  { ticker: 'MRK', names: ['merck'] },
  { ticker: 'MRVL', names: ['marvell'] },
  { ticker: 'MS', names: ['morgan stanley'] },
  { ticker: 'MSFT', names: ['microsoft'] },
  { ticker: 'MU', names: ['micron'] },
  { ticker: 'NET', names: ['cloudflare'] },
  { ticker: 'NFLX', names: ['netflix'] },
  { ticker: 'NIO', names: ['nio'] },
  { ticker: 'NKE', names: ['nike'] },
  { ticker: 'NOW', names: ['servicenow'] },
  { ticker: 'NVDA', names: ['nvidia'] },
  { ticker: 'OKTA', names: ['okta'] },
  { ticker: 'ORCL', names: ['oracle'] },
  { ticker: 'PANW', names: ['palo alto networks'] },
  { ticker: 'PATH', names: ['uipath'] },
  { ticker: 'PEP', names: ['pepsico', 'pepsi'] },
  { ticker: 'PFE', names: ['pfizer'] },
  { ticker: 'PG', names: ['procter & gamble', 'procter and gamble'] },
  { ticker: 'PINS', names: ['pinterest'] },
  { ticker: 'PLTR', names: ['palantir'] },
  { ticker: 'PYPL', names: ['paypal'] },
  { ticker: 'QCOM', names: ['qualcomm'] },
  { ticker: 'RBLX', names: ['roblox'] },
  { ticker: 'RIOT', names: ['riot platforms', 'riot'] },
  { ticker: 'RIVN', names: ['rivian'] },
  { ticker: 'ROKU', names: ['roku'] },
  { ticker: 'S', names: ['sentinelone'] },
  { ticker: 'SBUX', names: ['starbucks'] },
  { ticker: 'SCHW', names: ['charles schwab', 'schwab'] },
  { ticker: 'SHOP', names: ['shopify'] },
  { ticker: 'SNAP', names: ['snap', 'snapchat'] },
  { ticker: 'SNOW', names: ['snowflake'] },
  { ticker: 'SOFI', names: ['sofi'] },
  { ticker: 'TEAM', names: ['atlassian'] },
  { ticker: 'TMO', names: ['thermo fisher'] },
  { ticker: 'TSLA', names: ['tesla'] },
  { ticker: 'TSM', names: ['tsmc', 'taiwan semiconductor'] },
  { ticker: 'TTD', names: ['the trade desk', 'trade desk'] },
  { ticker: 'TXN', names: ['texas instruments'] },
  { ticker: 'UAL', names: ['united airlines', 'united'] },
  { ticker: 'UBER', names: ['uber'] },
  { ticker: 'UNH', names: ['unitedhealth'] },
  { ticker: 'UNP', names: ['union pacific'] },
  { ticker: 'V', names: ['visa'] },
  { ticker: 'VZ', names: ['verizon'] },
  { ticker: 'WFC', names: ['wells fargo'] },
  { ticker: 'WMT', names: ['walmart'] },
  { ticker: 'XOM', names: ['exxonmobil', 'exxon mobil', 'exxon'] },
  // "Square" deliberately NOT an alias for XYZ (Block, Inc. renamed from Square in 2023 —
  // the repo's own config comment documents the SQ->XYZ rename; old-name aliases rot).
  { ticker: 'XYZ', names: ['block'] },
  { ticker: 'ZM', names: ['zoom'] },
];

/** Every ticker the lexicon can resolve (bare token or company name). */
export const TICKERS_IN_LEXICON: Set<string> = new Set(TICKER_LEXICON.map((e) => e.ticker));

/** Ticker -> lowercase company-name aliases. */
export const TICKER_NAMES: Map<string, string[]> = new Map(
  TICKER_LEXICON.map((e) => [e.ticker, e.names]),
);

/**
 * Lowercase aliases that are also common English nouns/verbs/adjectives. A match on one of
 * these is accepted ONLY when the matched span is capitalized in the source text (proper-noun
 * use), e.g. "Apple" but not "apple", "Meta" but not "meta", "Block" but not "block".
 */
export const COMMON_WORD_NAMES: Set<string> = new Set([
  'alexandria',
  'apple',
  'arm',
  'block',
  'caterpillar',
  'delta',
  'ford',
  'marathon',
  'meta',
  'oracle',
  'riot',
  'united',
  'visa',
  'zoom',
]);

/**
 * Lexicon tickers that are common English words (or single letters) when seen as bare
 * uppercase tokens. These are NEVER accepted from a bare token alone — NewsSymbolExtractor
 * requires extra evidence ($TICKER marker, provider-supplied symbol, or a company-name
 * alias of the same ticker nearby) before accepting. Curated, not exhaustive; the evidence
 * rule is what protects against false matches, this list just names the known collisions.
 */
export const AMBIGUOUS_TICKERS: Set<string> = new Set([
  'A', // Agilent — also the indefinite article
  'AI', // C3.ai — also "artificial intelligence"
  'ARE', // Alexandria Real Estate — also "are"
  'BA', // Boeing — also "Bachelor of Arts"
  'C', // Citigroup — also the letter / vitamin C / C-suite
  'CAT', // Caterpillar — also the animal
  'COIN', // Coinbase — also "coin"
  'F', // Ford — also a grade / musical note
  'IT', // Gartner — also "it"
  'NET', // Cloudflare — also "net"
  'NOW', // ServiceNow — also "now"
  'ON', // ON Semiconductor — also "on"
  'PATH', // UiPath — also "path"
  'RIOT', // Riot Platforms — also "riot"
  'S', // SentinelOne — also a letter/plural
  'SHOP', // Shopify — also "shop"
  'SNAP', // Snap — also "snap"
  'SNOW', // Snowflake — also "snow"
  'TEAM', // Atlassian — also "team"
  'V', // Visa — also the letter / Roman numeral
]);
