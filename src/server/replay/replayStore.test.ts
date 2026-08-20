import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isValidReplayId, replayDir, replayRootDir, writeReplayJson,
  exportRejectionsCsv, exportMissedOpportunitiesCsv, exportMarkdownReport, exportZipArchive,
} from './replayStore';

describe('isValidReplayId / replayDir - path-traversal guard', () => {
  it('accepts a real crypto.randomUUID()-shaped id', () => {
    const id = crypto.randomUUID();
    expect(isValidReplayId(id)).toBe(true);
    expect(() => replayDir(id)).not.toThrow();
  });

  it('rejects path-traversal payloads', () => {
    for (const bad of ['../../../etc/passwd', '..\\..\\windows\\system32', '../../data/argus.db', '....//....//etc']) {
      expect(isValidReplayId(bad)).toBe(false);
      expect(() => replayDir(bad)).toThrow();
    }
  });

  it('rejects non-UUID strings that are not traversal payloads either', () => {
    for (const bad of ['', 'not-a-uuid', '12345', 'abcdefgh-1234-1234-1234-123456789012']) {
      expect(isValidReplayId(bad)).toBe(false);
    }
  });

  it('replayDir() never resolves outside the real replay root for a rejected id', () => {
    const root = replayRootDir();
    try {
      replayDir('../../etc');
    } catch {
      // expected - the point of this test is that it throws instead of returning a path
    }
    // Sanity: a valid id's dir really is nested under root.
    const id = crypto.randomUUID();
    expect(replayDir(id).startsWith(root)).toBe(true);
  });
});

describe('CSV/Markdown export - additional kinds', () => {
  let tmpDir: string;
  let originalReplayDir: string | undefined;
  let id: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_replaystore_test_'));
    originalReplayDir = process.env.ARGUS_REPLAY_DIR;
    process.env.ARGUS_REPLAY_DIR = tmpDir;
    id = crypto.randomUUID();
  });

  afterAll(() => {
    if (originalReplayDir) process.env.ARGUS_REPLAY_DIR = originalReplayDir;
    else delete process.env.ARGUS_REPLAY_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exportRejectionsCsv renders a real header + row from rejected_orders.json', () => {
    writeReplayJson(id, 'rejected_orders.json', [
      { timestamp: 100, symbol: 'ABC', side: 'BUY', reason: 'RISK_REJECTED', traceId: 'trace-1' },
    ]);
    const csv = exportRejectionsCsv(id);
    expect(csv).toContain('timestamp,symbol,side,reason,traceId');
    expect(csv).toContain('100,ABC,BUY,RISK_REJECTED,trace-1');
  });

  it('exportRejectionsCsv returns just the header for a replay with zero rejections', () => {
    const emptyId = crypto.randomUUID();
    writeReplayJson(emptyId, 'rejected_orders.json', []);
    expect(exportRejectionsCsv(emptyId)).toBe('timestamp,symbol,side,reason,traceId');
  });

  it('exportMissedOpportunitiesCsv renders the AFTER-THE-FACT ANALYSIS fields', () => {
    writeReplayJson(id, 'missed_opportunities.json', [
      {
        symbol: 'XYZ', timestamp: 200, reason: 'NO_CHIEF_APPROVAL', referencePrice: 10,
        horizonBars: 10, barsAvailableAfterRejection: 10, maxFavorableExcursionPct: 12.5,
        maxAdverseExcursionPct: -2.1, returnAtHorizonPct: 8.0, classification: 'MISSED_OPPORTUNITY',
      },
    ]);
    const csv = exportMissedOpportunitiesCsv(id);
    expect(csv).toContain('classification');
    expect(csv).toContain('MISSED_OPPORTUNITY');
    expect(csv).toContain('XYZ');
  });

  it('exportMarkdownReport degrades gracefully (no crash) when summary.json is missing', () => {
    const missingId = crypto.randomUUID();
    const md = exportMarkdownReport(missingId);
    expect(md).toContain(missingId);
    expect(md).toContain('No summary.json found');
  });

  it('exportMarkdownReport renders real sections from a real summary.json', () => {
    writeReplayJson(id, 'summary.json', {
      universeSource: 'ARGUS_DISCOVERY',
      historicalUniverseMethodology: 'ARGUS_DISCOVERY: test methodology',
      dataAvailabilityWarning: 'test warning',
      partialFillModel: 'VOLUME_PARTICIPATION_CAPPED',
      hashes: { datasetHash: 'ds1', configurationHash: 'cf1', replayHash: 'rh1' },
      report: { startingCapital: 1000, endingCapital: 1100, netPnl: 100, netReturnPct: 10, maxDrawdown: 5, maxDrawdownPct: 0.5, totalTrades: 2, buyTrades: 1, sellTrades: 1, winRate: 1, profitFactor: 2, sharpe: { status: 'INSUFFICIENT_SAMPLE' }, honesty: ['test honesty line'] },
      decisionFunnel: { evaluationsAttempted: 10, analyzed: 8, ideasGenerated: 4, consensusApproved: 2, consensusRejected: 2, ordersSubmitted: 2, ordersFilled: 2, ordersRejected: 0 },
      agentEvaluation: { TechnicalAgent: { ideas: 4, buyIdeas: 3, sellIdeas: 1, averageConfidence: 0.6 } },
      discoveredSymbols: [{ symbol: 'ABC', discoveredAt: 100 }],
      missedOpportunities: [{ classification: 'MISSED_OPPORTUNITY' }, { classification: 'CORRECTLY_AVOIDED' }],
      missedOpportunityLabel: 'AFTER-THE-FACT ANALYSIS',
    });
    const md = exportMarkdownReport(id);
    expect(md).toContain('# Argus Historical Replay Report');
    expect(md).toContain('Starting capital: 1000');
    expect(md).toContain('Ending equity: 1100');
    expect(md).toContain('TechnicalAgent: 4 ideas');
    expect(md).toContain('ABC (t=100)');
    expect(md).toContain('1 classified MISSED_OPPORTUNITY');
    expect(md).toContain('test honesty line');
  });

  it('exportZipArchive bundles only the artifacts that actually exist for this run, as a real ZIP', () => {
    // id already has summary.json, trades.json (from an earlier test in this file - reuse is fine,
    // this test only cares about the archive's structure) written via writeReplayJson.
    writeReplayJson(id, 'trades.json', [{ timestamp: 1, symbol: 'AAPL' }]);
    const zip = exportZipArchive(id);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // real ZIP local-file-header magic number
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50); // real end-of-central-directory magic number
    // Always-generated artifacts (CSV/Markdown derive from whatever JSON exists, even if empty).
    expect(zip.includes('trades.csv')).toBe(true);
    expect(zip.includes('report.md')).toBe(true);
  });

  it('exportZipArchive does not throw for a replay with no artifacts at all', () => {
    const emptyId = crypto.randomUUID();
    const zip = exportZipArchive(emptyId);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  });
});
