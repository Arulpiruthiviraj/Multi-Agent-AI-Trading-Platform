CREATE TABLE IF NOT EXISTS insider_transactions (
  accession_number TEXT PRIMARY KEY,
  cik TEXT NOT NULL,
  ticker TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  transaction_date TEXT,
  insider_name TEXT,
  insider_title TEXT,
  transaction_code TEXT,
  shares REAL,
  price_per_share REAL,
  shares_owned_after REAL,
  is_direct INTEGER,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_insider_transactions_ticker_filing ON insider_transactions (ticker, filing_date);
