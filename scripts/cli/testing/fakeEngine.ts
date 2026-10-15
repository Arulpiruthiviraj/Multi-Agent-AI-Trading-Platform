/**
 * FakeEngine: a deterministic, in-process stand-in for the Argus engine HTTP API, used ONLY by isolated CLI lifecycle tests (2026-10-15).
 * It binds an ephemeral loopback port (never 3000), holds no database or broker, and records every request so tests can assert exactly what the CLI asked for.
 * It exists so lifecycle faults (ignored shutdown, slow shutdown, refused resume, reconciliation mismatch, wedged server) can be reproduced without touching
 * the real engine, its SQLite file or any broker.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type ShutdownBehavior = 'exit' | 'ignore' | { exitAfterMs: number };
export interface FakeEngineOptions {
  pid?: number;
  tradingState?: string;
  emergencyStopActive?: boolean;
  shutdown?: ShutdownBehavior;
  /** reconciliation snapshot served at /api/v1/system/reconciliation/status */
  reconciliation?: { syncState: string; mismatches: unknown[] | null } | 'ERROR';
  /** when set, POST /api/v1/system/resume answers 409 with this error text instead of enabling trading */
  resumeRefusal?: string;
  /** when true every request hangs (a wedged but listening server) */
  wedged?: boolean;
}
export interface RecordedRequest { method: string; path: string; at: number }

export class FakeEngine {
  readonly requests: RecordedRequest[] = [];
  tradingState: string;
  emergencyStopActive: boolean;
  private server: http.Server | null = null;
  private opts: FakeEngineOptions & { pid: number; shutdown: ShutdownBehavior };
  private sockets = new Set<import('node:net').Socket>();

  constructor(opts: FakeEngineOptions = {}) {
    this.opts = { pid: 424242, shutdown: 'exit', ...opts };
    this.tradingState = opts.tradingState ?? 'TRADING_ENABLED';
    this.emergencyStopActive = opts.emergencyStopActive ?? false;
  }

  get url(): string { const a = this.server?.address() as AddressInfo | null; if (!a) throw new Error('FakeEngine not started'); return `http://127.0.0.1:${a.port}`; }
  get listening(): boolean { return !!this.server && this.server.listening; }
  get pid(): number { return this.opts.pid; }
  count(method: string, path: string): number { return this.requests.filter((r) => r.method === method && r.path === path).length; }
  setOptions(next: Partial<FakeEngineOptions>): void { Object.assign(this.opts, next); }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    const s = this.server; this.server = null;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'fake-req' });
    res.end(JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];
    this.requests.push({ method: req.method ?? 'GET', path, at: Date.now() });
    if (this.opts.wedged) return; // never answer
    if (req.method === 'GET' && (path === '/api/v2/runtime/health' || path === '/health' || path === '/ready')) {
      return this.json(res, 200, { ok: true, status: 'ok', health: { ok: true, pid: this.opts.pid, phase: 'RUNNING', tradingState: this.tradingState, emergencyStopActive: this.emergencyStopActive, brokerId: 'fake_broker' } });
    }
    if (req.method === 'GET' && path === '/api/v2/runtime/status') {
      return this.json(res, 200, { ok: true, autobot: { tradingState: this.tradingState, emergencyStopActive: this.emergencyStopActive }, system: { mode: 'PAPER' } });
    }
    if (req.method === 'GET' && path === '/api/v1/system/reconciliation/status') {
      const r = this.opts.reconciliation ?? { syncState: 'READY', mismatches: [] };
      if (r === 'ERROR') return this.json(res, 500, { error: 'reconciliation unavailable' });
      return this.json(res, 200, { tradingState: this.tradingState, broker: { syncState: r.syncState }, latest: { mismatches: r.mismatches, matches: 3 } });
    }
    if (req.method === 'POST' && path === '/api/v1/system/shutdown') {
      this.json(res, 200, { ok: true, message: 'graceful shutdown requested' });
      const b = this.opts.shutdown;
      if (b === 'exit') setTimeout(() => { void this.close(); }, 50);
      else if (typeof b === 'object') setTimeout(() => { void this.close(); }, b.exitAfterMs);
      return;
    }
    if (req.method === 'POST' && path === '/api/v1/system/resume') {
      if (this.opts.resumeRefusal) return this.json(res, 409, { error: this.opts.resumeRefusal });
      this.tradingState = 'TRADING_ENABLED';
      return this.json(res, 200, { status: 'ok', active: false, tradingState: this.tradingState });
    }
    if (req.method === 'POST' && path === '/api/v1/system/pause') {
      this.tradingState = 'TRADING_PAUSED';
      return this.json(res, 200, { status: 'ok', tradingState: this.tradingState });
    }
    return this.json(res, 404, { error: 'not found' });
  }
}
