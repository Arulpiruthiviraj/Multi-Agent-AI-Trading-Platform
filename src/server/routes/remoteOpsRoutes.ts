/**
 * Remote diagnostics, log tail, and allowlisted operator job endpoints (/api/v2/system/*).
 * Auth is enforced by server.ts middleware on /api/* — these routes assume an authenticated session.
 */
import os from 'os';
import fs from 'fs';
import { Router, type Request, type Response } from 'express';
import { dbPath } from '../db';
import { networkEndpoints } from '../config/networkEndpoints';
import { tradingSafety } from '../config/tradingSafety';
import { getWsClientCount } from '../core/wsRegistry';
import {
  abortRemoteOp,
  executeRemoteOp,
  getRemoteOpState,
  listRemoteOpJobs,
} from '../services/RemoteOperationsService';
import { getRecentLogLines, installServerLogBuffer } from '../services/ServerLogBuffer';

let logBufferInstalled = false;

function ensureLogBuffer(): void {
  if (logBufferInstalled) return;
  installServerLogBuffer();
  logBufferInstalled = true;
}

async function probeAlpacaReachability(): Promise<{
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  clockStatus: string | null;
  error: string | null;
}> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) {
    return { configured: false, reachable: false, latencyMs: null, clockStatus: null, error: 'Alpaca keys not configured' };
  }

  const paper = process.env.PAPER_TRADING_ONLY !== 'false';
  const base = paper ? networkEndpoints.broker.alpaca.paperBaseUrl : networkEndpoints.broker.alpaca.liveBaseUrl;
  const started = Date.now();
  try {
    const res = await fetch(`${base}/v2/clock`, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
      },
      signal: AbortSignal.timeout(tradingSafety.alpacaRequestTimeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        configured: true,
        reachable: false,
        latencyMs,
        clockStatus: null,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { is_open?: boolean };
    return {
      configured: true,
      reachable: true,
      latencyMs,
      clockStatus: body.is_open ? 'open' : 'closed',
      error: null,
    };
  } catch (e: any) {
    return {
      configured: true,
      reachable: false,
      latencyMs: Date.now() - started,
      clockStatus: null,
      error: e?.message || String(e),
    };
  }
}

function dbSizeBytes(): number | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    return fs.statSync(dbPath).size;
  } catch {
    return null;
  }
}

export function mountRemoteOpsRoutes(router: Router): void {
  ensureLogBuffer();

  router.get('/system/diagnostics', async (_req: Request, res: Response) => {
    const mem = process.memoryUsage();
    const alpaca = await probeAlpacaReachability();
    res.json({
      ok: true,
      uptimeSec: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      cpuLoad: os.loadavg(),
      wsClientCount: getWsClientCount(),
      dbPath,
      dbSizeBytes: dbSizeBytes(),
      alpaca,
      remoteOp: getRemoteOpState(),
      allowedJobs: listRemoteOpJobs(),
    });
  });

  router.get('/system/logs/recent', (req: Request, res: Response) => {
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    res.json({ ok: true, lines: getRecentLogLines(limit) });
  });

  router.post('/system/ops/execute', async (req: Request, res: Response) => {
    const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId.trim() : '';
    if (!jobId) {
      return res.status(400).json({ ok: false, error: 'jobId is required' });
    }
    const result = await executeRemoteOp(jobId);
    if (result.ok === false) {
      const { error, status } = result;
      return res.status(status ?? 400).json({ ok: false, error });
    }
    res.json({ ok: true, jobId: result.jobId, state: getRemoteOpState() });
  });

  router.post('/system/ops/abort', (_req: Request, res: Response) => {
    const result = abortRemoteOp();
    if (result.ok === false) {
      return res.status(409).json({ ok: false, error: result.error });
    }
    res.json({ ok: true, aborted: result.aborted, state: getRemoteOpState() });
  });
}

export const remoteOpsRouter = Router();
mountRemoteOpsRoutes(remoteOpsRouter);
