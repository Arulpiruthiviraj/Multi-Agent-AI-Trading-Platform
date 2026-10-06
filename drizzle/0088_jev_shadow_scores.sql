-- Jev shadow-scoring agreement ledger (Phase 1, 2026-10-06).
-- Every row is one article scored by Jev in shadow mode, optionally joined to the LLM's
-- own analysis of the same article for calibration measurement. Jev scores NEVER influence
-- trading; this table exists to build the agreement evidence Phase 2 requires.
CREATE TABLE jev_shadow_scores (
  id TEXT PRIMARY KEY,
  article_fingerprint TEXT NOT NULL,          -- joins to news_articles.fingerprint; dedup key
  symbol TEXT NOT NULL,
  trace_id TEXT,                              -- joins to the NewsEngine cycle's trace
  jev_model TEXT NOT NULL,                    -- actual model that answered (e.g. jev-1.13.0), not the alias
  jev_relevant_prob REAL,                     -- P(relevant), 0..1
  jev_relevant_conf REAL,                     -- min confidence across questions, 0..1
  jev_sentiment TEXT,                         -- bullish | bearish | neutral
  jev_sentiment_conf REAL,
  jev_sentiment_probs TEXT,                   -- JSON {bullish,bearish,neutral}
  jev_impact_score REAL,                      -- 0..10
  jev_impact_conf REAL,
  jev_surprise_prob REAL,                     -- P(genuine surprise), 0..1
  jev_contradiction_prob REAL,                -- P(contradictory evidence), 0..1
  jev_urgency_score REAL,                     -- 0..10
  jev_urgency_conf REAL,
  jev_input_tokens INTEGER NOT NULL DEFAULT 0,
  jev_latency_ms INTEGER NOT NULL DEFAULT 0,
  -- LLM side, populated when the same article also got LLM analysis (escalated articles).
  llm_sentiment_score REAL,                   -- -1..1 scale from AIAnalysisResult
  llm_trading_bias TEXT,                      -- BULLISH | BEARISH | NEUTRAL
  llm_market_impact_score REAL,               -- 0..100
  llm_confidence REAL,                        -- 0..100
  llm_surprise REAL,                          -- 0..1
  -- Agreement metrics, computed at write time so calibration queries stay cheap.
  sentiment_agree INTEGER,                    -- 1 when jev sentiment direction matches llm bias, 0 when not, NULL when llm side absent
  scored_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_jev_shadow_scores_symbol ON jev_shadow_scores(symbol);
--> statement-breakpoint
CREATE INDEX idx_jev_shadow_scores_fingerprint ON jev_shadow_scores(article_fingerprint);
