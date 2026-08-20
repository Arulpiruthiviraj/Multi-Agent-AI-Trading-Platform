#!/usr/bin/env node
/** One-shot RUN-VERIFIED helper for Phase C real-data discovery replay. */
import 'dotenv/config';

async function main() {
  const hasKeys = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
  console.log(JSON.stringify({ step: 'check_keys', hasAlpacaKeys: hasKeys }));
  if (!hasKeys) {
    console.log(JSON.stringify({ result: 'NOT VERIFIED', reason: 'ALPACA_API_KEY/ALPACA_SECRET_KEY unset in environment' }));
    process.exit(2);
  }
  const { createReplayRun, startReplay } = await import('../src/server/replay/FullArgusReplayEngine');
  const created = await createReplayRun({
    universeSource: 'ARGUS_DISCOVERY',
    dataProvider: 'alpaca',
    startDate: '2024-01-02',
    endDate: '2024-01-31',
    initialCapital: 2000,
    aiMode: 'DISABLED',
    speed: 'MAX',
    randomSeed: 42,
  });
  console.log(JSON.stringify({ step: 'create', status: (created as any).status, universeSource: (created as any).universeSource, error: (created as any).error }));
  if ((created as any).status === 'DATA_UNAVAILABLE' || (created as any).status === 'FAILED') {
    console.log(JSON.stringify({ result: 'NOT VERIFIED', reason: (created as any).error || (created as any).status }));
    process.exit(3);
  }
  const started = await startReplay(String((created as any).replayId));
  console.log(JSON.stringify({
    result: 'RUN-VERIFIED',
    replayId: (created as any).replayId,
    status: (started as any).status,
    universeSource: (started as any).universeSource,
    discoveredCount: (started as any).discoveredSymbols?.length ?? 0,
    evaluationsAttempted: (started as any).decisionFunnel?.evaluationsAttempted,
    buyTrades: (started as any).report?.buyTrades,
    sellTrades: (started as any).report?.sellTrades,
    historicalFidelity: (started as any).historicalEvaluation?.historicalFidelity,
    dataProvider: 'alpaca',
  }));
}

main().catch((e) => {
  console.log(JSON.stringify({ result: 'NOT VERIFIED', reason: String(e.message || e) }));
  process.exit(1);
});
