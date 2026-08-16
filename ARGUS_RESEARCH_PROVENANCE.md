# ARGUS_RESEARCH_PROVENANCE

Canonical fill: signal at T, execute T+1 open.  
Version: `argus-research-execution-v1`.  
Cost model today: **THEORETICAL_ZERO_COST** (`commissionPerShare/spreadBps/slippageBps` = 0) → cannot `backtestPass`.

Provenance labels: REAL_MARKET_DATA | UNIT_FIXTURE | SYNTHETIC_TEST_DATA | UNKNOWN | …  
Only REAL_MARKET_DATA + GREEN quality can promote.

Warehouse: Alpaca raw bars, paginated; grade raw then cleaned; missing intervals counted; do not fabricate gaps. Parquet write opt-in `ARGUS_WRITE_RESEARCH_PARQUET=true`.

Runs: in-memory registry; disk under `data/research/runs/<runId>/` when the write flag is set.

Experiment ledger counts trials for multiple-testing warnings.
