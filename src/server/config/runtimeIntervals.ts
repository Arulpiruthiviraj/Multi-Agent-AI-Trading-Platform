/**
 * Loads config/runtimeIntervals.json. Cadences and caps for periodic workers.
 * Missing required keys fail boot.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface RuntimeIntervals {
  fundamentalAgentMs: number;
  macroAgentMs: number;
  portfolioMonitorMs: number;
  reflectionEngineMs: number;
  newsEngineMs: number;
  /** Off-hours / weekend NewsEngine poll cadence (conservation). */
  newsEngineOffHoursMs: number;
  /** After 09:30 ET, how long staged catalysts may be matched to opening ticks. */
  newsOpenConfluenceWindowMs: number;
  /** ET minutes since midnight when INTRADAY staged catalysts expire (e.g. 630 = 10:30). */
  newsIntradayStageUntilEtMinutes: number;
  rssFeedErrorBackoffMs: number;
  rssFeedFetchTimeoutMs: number;
  chiefTraderWeightSyncMs: number;
  chiefTraderIdeaTtlMs: number;
  systemMetricsMs: number;
  portfolioReconciliationMs: number;
  reconciliationBootWarmupMs: number;
  marketDataReconnectMs: number;
  networkReconnectBackoffMs: number[];
  marketDataCrossCheckMs: number;
  kronosRecheckMs: number;
  kronosPredictionCooldownMs: number;
  kronosHttpTimeoutMs: number;
  /** Max in-flight Chronos /forecast HTTP calls (serialize CPU timeout storms). */
  kronosForecastMaxConcurrent: number;
  openAlicePollMs: number;
  openAliceRequestTimeoutMs: number;
  openAliceMcpDefaultTimeoutMs: number;
  modelRuntimeProbeTimeoutMs: number;
  /** 2026-10-08 (defect A2): max concurrently tracked model-runtime children (Ollama/Chronos
   *  companions). Spawns past the cap are refused and the excess child is killed, not leaked. */
  modelRuntimeMaxChildren: number;
  /** Bounded timeout for a real, cheap Ollama completion capability check (not just /api/tags
   *  reachability) — a loaded/OOM/misconfigured local model can be slower than the plain
   *  reachability probe above without being genuinely unavailable. */
  ollamaCompletionProbeTimeoutMs: number;
  fundamentalsCacheMaxAgeMs: number;
  macroCacheMaxAgeMs: number;
  externalDataRateLimitCooldownMs: number;
  dbBackupIntervalMs: number;
  dbBackupRetentionDays: number;
  /** 2026-10-07 defect fix: day-based retention alone is unsustainable once the live DB is
   *  multi-GB (30 days x ~13GB observed = ~390GB) - this caps the number of successful backups
   *  kept regardless of age, whichever bound (this or dbBackupRetentionDays) is more restrictive. */
  dbBackupMaxCount: number;
  /** 2026-10-07 defect fix: a `.partial`/`.partial-wal`/`.partial-shm`/`.partial-journal` file
   *  orphaned by a process restart mid-copy (previously never cleaned by anything, confirmed live:
   *  62GB of these accumulated) is swept once older than this age - a legitimate in-progress
   *  backup is always younger than this. */
  dbBackupOrphanCleanupAgeMs: number;
  /** 2026-10-07 defect fix: refuse to start a new backup copy if free disk space is below the
   *  live DB's current size times this multiplier, rather than starting a multi-GB copy that can
   *  run the disk to zero mid-write. */
  dbBackupMinFreeSpaceMultiplier: number;
  /** 2026-10-08: backup work runs in a worker_thread; this bounds how long the main thread waits
   *  for it before terminating the worker and marking the run FAILED. Generous on purpose - a
   *  16GB copy + integrity check on a slow disk takes tens of minutes, and a premature timeout
   *  would strand a .partial orphan (swept later, but still wasted I/O). */
  dbBackupWorkerTimeoutMs: number;
  eventStoreMaxRecentEvents: number;
  eventStoreMaxTraces: number;
  eventStoreSchemaVersion: number;
  agentActivityWindowMs: number;
  opportunityWindowHours: number;
  omsFollowUpMinAgeMs: number;
  omsFollowUpIntervalMs: number;
  omsPollForFillTimeoutMs: number;
  omsPollForFillIntervalMs: number;
  autoTradeSchedulerMs: number;
  strategyEngineShadowMs: number;
  javaQuantAdvisoryMs: number;
  /** 2026-10-05: InstitutionalStrategyVoteService round-robin cadence (one symbol per tick). */
  institutionalStrategyVoteMs: number;
  /** 2026-10-05: SecEdgarForm4Scraper poll cadence. */
  secEdgarForm4Ms: number;
  aiProviderHealthCheckMs: number;
  /** How often the live SessionLifecycle worker re-classifies PRE_MARKET/REGULAR/AFTER_HOURS/CLOSED. */
  sessionLifecycleEvalMs: number;
  /** How often the observational calibration-candidate validation cycle re-runs (Phase 7E). */
  calibrationValidationCycleMs: number;
  /** heartbeatWatchdog.ts (R2 remediation) check cadence. */
  heartbeatWatchdogCheckMs: number;
  /** Crypto Expansion Phase 4 (2026-09-21): CryptoMarketDataIngestion.ts poll cadence (REST, no
   *  crypto WebSocket stream exists yet - see AlpacaCryptoMarketData.ts). */
  cryptoMarketDataIngestionMs: number;
  /** Real defect fixed 2026-09-22 (CLI forensics pass, live-database-verified): candidate_rankings
   *  had no retention policy at all - 1.38M+ rows accumulated since this table's introduction with
   *  zero pruning anywhere in the codebase (unlike observability_events, which has a real
   *  sweepObservabilityRetention() on retentionDays=14). This is the operationalRetention.ts sweep's
   *  cutoff, mirroring that same pattern for this table specifically - a rolling ranking-cycle
   *  snapshot with no long-term audit-trail requirement (distinct from trades/fills/risk_assessments/
   *  event_traces, which stay unpruned by design as the permanent decision record). */
  candidateRankingsRetentionDays: number;
  /** Sweep cadence for the above - mirrors observability.json's retentionSweepMs pattern. */
  candidateRankingsRetentionSweepMs: number;
  /** 2026-10-01 defect verification pass - see config/runtimeIntervals.json's own comment. Bounds
   *  a single sweepCandidateRankingsRetention() call the same way observability.json's
   *  retentionSweepBatchSize/retentionSweepMaxBatchesPerCall bound ObservabilityStore.ts's sweep. */
  candidateRankingsRetentionSweepBatchSize: number;
  candidateRankingsRetentionSweepMaxBatchesPerCall: number;
  /** 2026-10-08 memory-leak follow-up: news_articles had no retention policy anywhere in the
   *  codebase (same defect class as candidate_rankings 2026-09-22). Article rows are bulky and
   *  lose trading value within hours - 30 days is generous. */
  newsArticlesRetentionDays: number;
  /** news_clusters are the durable news record of truth (small metadata rows; news_predictions
   *  link to cluster ids) - longer 90-day window. */
  newsClustersRetentionDays: number;
  /** Batching bounds for the news sweeps - same batching + yielding discipline as the
   *  candidate_rankings sweep so a large backlog can never block the event loop. */
  newsRetentionSweepBatchSize: number;
  newsRetentionSweepMaxBatchesPerCall: number;
  /** 2026-10-08 defect hunt (news D2 / infra P2-R1/R3): four more append-only news/AI
   *  tables with no prune path. escalation_decisions (one row per analyzed article) and
   *  staged terminal catalyst rows lose value within days; jev_shadow_scores and ai_calls
   *  (bulky prompt/response text) get 30 days; news_predictions aligns to news_clusters (90d). */
  escalationDecisionsRetentionDays: number;
  jevShadowScoresRetentionDays: number;
  newsPredictionsRetentionDays: number;
  stagedNewsCatalystsTerminalRetentionDays: number;
  aiCallsRetentionDays: number;
  /** 2026-10-08 synthetic session guard: a 6-minute synthetic session wrote rows
   *  to 8 tables with no retention path. Conservative bounds: ohlcv_bars keeps a
   *  full year for backtests/audits; predictions are graded within hours
   *  (evaluationHorizonMs=1h) so 30d is generous; ledgers/traces keep 90d. */
  ohlcvBarsRetentionDays: number;
  agentPredictionsRetentionDays: number;
  quantAssessmentsRetentionDays: number;
  pitDecisionLedgerRetentionDays: number;
  agentReasoningLogsRetentionDays: number;
  transactionTracesRetentionDays: number;
  sessionLifecycleSnapshotsRetentionDays: number;
  tradeLifecycleTransitionsRetentionDays: number;
  /** 2026-10-09 (certification mission item 1 - OCT9_PIT_PROVENANCE_ESCAPE): retention for
   *  the decision_provenance table (per-Quant-decision PIT replay provenance). 90 days,
   *  aligned with pitDecisionLedgerRetentionDays — both are decision-audit records; the
   *  provenance row is what lets a past decision be replayed identically. */
  decisionProvenanceRetentionDays: number;
  /** 2026-10-10 defect hunt (Track 1, soak-path retention): a 180-sim-minute SOAK_3H
   *  synthetic session wrote rows to consensus_debate_predictions (27), consensus_decisions
   *  (8), consensus_evidence (10) and reconciliation_events (1) with no prune path anywhere
   *  in the codebase — the same defect class as candidate_rankings/news_articles. These are
   *  decision-audit records (90d, aligned with pitDecisionLedger/decisionProvenance), not the
   *  permanent decision record (event_traces/trades/fills/risk_assessments stay unpruned).
   *  consensus_evidence has no timestamp of its own; its sweeper prunes via the parent
   *  consensus_decisions row (same transaction, TransactionRegistry). */
  consensusDebatePredictionsRetentionDays: number;
  consensusDecisionsRetentionDays: number;
  consensusEvidenceRetentionDays: number;
  reconciliationEventsRetentionDays: number;
  /** 2026-10-10 defect hunt (Track 1, soak-path retention, part 2): twelve more
   *  append-only tables on the session path with no prune path. None fired in the
   *  all-AI-down probe iteration (AI/Kronos down, no fills, no misses), but each is
   *  written by a session worker in a live configuration: portfolio_snapshots (per
   *  reconciliation check with holdings), ai_usage (per AI call), kronos_predictions
   *  (per Kronos forecast), prediction_outcomes + prediction_outcome_horizons (outcome
   *  evaluators on timers), missed_opportunities (detector), learning_observations (on
   *  closed trades), meta_label_features (vote path), quant_forecasts (forecastEngine),
   *  explainability_reports (per decision), training_examples (builder timer),
   *  learned_rules (ReflectionEngine). Fast-decaying artifacts (usage, forecasts,
   *  kronos predictions) get 30d; audit/learning records get 90d. risk_gate_results
   *  is deliberately NOT swept: it is the per-gate detail of risk_assessments, which
   *  is in the permanent decision record by design. */
  portfolioSnapshotsRetentionDays: number;
  aiUsageRetentionDays: number;
  kronosPredictionsRetentionDays: number;
  predictionOutcomesRetentionDays: number;
  predictionOutcomeHorizonsRetentionDays: number;
  missedOpportunitiesRetentionDays: number;
  learningObservationsRetentionDays: number;
  metaLabelFeaturesRetentionDays: number;
  quantForecastsRetentionDays: number;
  explainabilityReportsRetentionDays: number;
  trainingExamplesRetentionDays: number;
  learnedRulesRetentionDays: number;
  /** 2026-10-08 (defect A1): how long an aiProviders.health='Offline' quarantine must age
   *  (measured from the row's last_failure) before AIProviderHealthCheck's real re-probe may
   *  restore the provider to 'Degraded' on success. A failed re-probe keeps it Offline. */
  aiProviderQuarantineCooldownMs: number;
}

const REQUIRED_KEYS: (keyof RuntimeIntervals)[] = [
  'fundamentalAgentMs', 'macroAgentMs', 'portfolioMonitorMs', 'reflectionEngineMs', 'newsEngineMs',
  'newsEngineOffHoursMs', 'newsOpenConfluenceWindowMs', 'newsIntradayStageUntilEtMinutes',
  'rssFeedErrorBackoffMs', 'rssFeedFetchTimeoutMs',
  'chiefTraderWeightSyncMs', 'chiefTraderIdeaTtlMs', 'systemMetricsMs', 'portfolioReconciliationMs',
  'reconciliationBootWarmupMs', 'marketDataReconnectMs', 'networkReconnectBackoffMs', 'marketDataCrossCheckMs', 'kronosRecheckMs', 'kronosPredictionCooldownMs',
  'kronosHttpTimeoutMs', 'kronosForecastMaxConcurrent', 'openAlicePollMs', 'openAliceRequestTimeoutMs', 'openAliceMcpDefaultTimeoutMs',
  'modelRuntimeProbeTimeoutMs', 'modelRuntimeMaxChildren', 'ollamaCompletionProbeTimeoutMs', 'fundamentalsCacheMaxAgeMs', 'macroCacheMaxAgeMs',
  'externalDataRateLimitCooldownMs', 'dbBackupIntervalMs', 'dbBackupRetentionDays',
  'dbBackupMaxCount', 'dbBackupOrphanCleanupAgeMs', 'dbBackupMinFreeSpaceMultiplier',
  'dbBackupWorkerTimeoutMs',
  'eventStoreMaxRecentEvents', 'eventStoreMaxTraces', 'eventStoreSchemaVersion',
  'agentActivityWindowMs', 'opportunityWindowHours', 'omsFollowUpMinAgeMs', 'omsFollowUpIntervalMs',
  'omsPollForFillTimeoutMs', 'omsPollForFillIntervalMs', 'autoTradeSchedulerMs', 'strategyEngineShadowMs',
  'javaQuantAdvisoryMs', 'institutionalStrategyVoteMs', 'secEdgarForm4Ms', 'aiProviderHealthCheckMs', 'sessionLifecycleEvalMs', 'calibrationValidationCycleMs',
  'heartbeatWatchdogCheckMs', 'cryptoMarketDataIngestionMs',
  'candidateRankingsRetentionDays', 'candidateRankingsRetentionSweepMs',
  'candidateRankingsRetentionSweepBatchSize', 'candidateRankingsRetentionSweepMaxBatchesPerCall',
  'newsArticlesRetentionDays', 'newsClustersRetentionDays',
  'newsRetentionSweepBatchSize', 'newsRetentionSweepMaxBatchesPerCall',
  'escalationDecisionsRetentionDays', 'jevShadowScoresRetentionDays',
  'newsPredictionsRetentionDays', 'stagedNewsCatalystsTerminalRetentionDays',
  'aiCallsRetentionDays',
  'ohlcvBarsRetentionDays', 'agentPredictionsRetentionDays',
  'quantAssessmentsRetentionDays', 'pitDecisionLedgerRetentionDays',
  'agentReasoningLogsRetentionDays', 'transactionTracesRetentionDays',
  'sessionLifecycleSnapshotsRetentionDays', 'tradeLifecycleTransitionsRetentionDays',
  'decisionProvenanceRetentionDays',
  'consensusDebatePredictionsRetentionDays', 'consensusDecisionsRetentionDays',
  'consensusEvidenceRetentionDays', 'reconciliationEventsRetentionDays',
  'portfolioSnapshotsRetentionDays', 'aiUsageRetentionDays',
  'kronosPredictionsRetentionDays', 'predictionOutcomesRetentionDays',
  'predictionOutcomeHorizonsRetentionDays', 'missedOpportunitiesRetentionDays',
  'learningObservationsRetentionDays', 'metaLabelFeaturesRetentionDays',
  'quantForecastsRetentionDays', 'explainabilityReportsRetentionDays',
  'trainingExamplesRetentionDays', 'learnedRulesRetentionDays',
  'aiProviderQuarantineCooldownMs',
];

function loadRuntimeIntervals(): RuntimeIntervals {
  const raw = loadRepoConfigJson<Record<string, unknown>>('runtimeIntervals.json');
  for (const key of REQUIRED_KEYS) {
    if (key === 'networkReconnectBackoffMs') {
      const arr = raw[key];
      if (!Array.isArray(arr) || arr.length === 0 || !arr.every(v => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error('config/runtimeIntervals.json missing numeric array field: networkReconnectBackoffMs');
      }
      continue;
    }
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/runtimeIntervals.json missing numeric field: ${key}`);
    }
  }
  return raw as unknown as RuntimeIntervals;
}

export const runtimeIntervals: RuntimeIntervals = loadRuntimeIntervals();
