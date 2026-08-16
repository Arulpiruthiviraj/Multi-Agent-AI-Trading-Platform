import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.ARGUS_DB_PATH = path.join(os.tmpdir(), `argus_p24_demo_${Date.now()}.db`);
process.env.ARGUS_REPLAY_DIR = path.join(os.tmpdir(), `argus_p24_demo_replays_${Date.now()}`);
fs.mkdirSync(process.env.ARGUS_REPLAY_DIR, { recursive: true });

const { createReplayRun, startReplay } = await import('../src/server/replay/FullArgusReplayEngine.ts');
const created = await createReplayRun({
  dataProvider: 'golden_replay',
  newsProvider: 'golden_replay_news',
  symbols: ['AAPL'],
  strategyIds: ['MOMENTUM_BREAKOUT'],
  aiMode: 'DISABLED',
  speed: 'MAX',
  costProfile: 'Base',
  initialCapital: 100000,
  allocationBudget: 3000,
  randomSeed: 1,
});
const started: any = await startReplay(String(created.replayId));
console.log(JSON.stringify({
  replayId: started.replayId,
  status: started.status,
  datasetHash: started.hashes?.datasetHash,
  period: 'golden_fixture_80_bars',
  symbols: (created as any).config?.symbols,
  initialCapital: started.report?.startingCapital,
  finalEquity: started.report?.endingCapital,
  netPnl: started.report?.netPnl,
  returnPct: started.report?.netReturnPct,
  tradeCount: started.report?.totalTrades,
  buyTrades: started.report?.buyTrades,
  sellTrades: started.report?.sellTrades,
  fees: started.report?.totalFees,
  slippage: started.report?.totalSlippage,
  executionModel: started.report?.executionModel,
  live: started.live,
  organicPaper: started.organicPaper,
  canPromote: started.canPromoteFromThisReplay,
}, null, 2));
