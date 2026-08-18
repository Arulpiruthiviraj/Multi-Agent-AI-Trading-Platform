/**
 * Mobile-friendly remote operations console: diagnostics, allowlisted jobs, live log tail.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Cpu,
  Database,
  Play,
  Square,
  Terminal,
  Wifi,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { useWebSocket } from '../../context/WebSocketContext';

import {
  compactLogLine,
  isDevNoiseLogLine,
  matchesMobileLogFilter,
  stripAnsi,
  type MobileLogFilter,
} from './mobileLogSanitize';

interface ServerLogLine {
  id: string;
  ts: string;
  level: 'log' | 'warn' | 'error';
  text: string;
  source: 'console' | 'remote-op';
  category: 'SYSTEM' | 'TRADING' | 'ERROR' | 'SCRIPT';
  jobId?: string;
  stream?: 'stdout' | 'stderr';
}

interface DiagnosticsPayload {
  ok: boolean;
  uptimeSec: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  cpuLoad: number[];
  wsClientCount: number;
  dbSizeBytes: number | null;
  alpaca: {
    configured: boolean;
    reachable: boolean;
    latencyMs: number | null;
    clockStatus: string | null;
    error: string | null;
  };
  remoteOp: {
    jobId: string | null;
    status: string;
    durationMs: number | null;
    exitCode: number | null;
  };
  allowedJobs: Array<{ jobId: string; description: string; timeoutMs: number }>;
}

function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

function matchesFilter(line: ServerLogLine, filter: MobileLogFilter): boolean {
  if (filter === 'ALL') return !isDevNoiseLogLine(line.text);
  return matchesMobileLogFilter(line.text, line.level, line.category, filter);
}

function lineTone(line: ServerLogLine): string {
  if (line.level === 'error' || line.category === 'ERROR') return 'text-rose-400';
  if (line.category === 'TRADING') return 'text-emerald-400';
  if (line.category === 'SCRIPT') return 'text-indigo-300';
  return 'text-slate-300';
}

export function MobileOpsConsole() {
  const { subscribe, status: wsStatus } = useWebSocket();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsPayload | null>(null);
  const [lines, setLines] = useState<ServerLogLine[]>([]);
  const [filter, setFilter] = useState<MobileLogFilter>('ALL');
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const loadDiagnostics = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/system/diagnostics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DiagnosticsPayload;
      setDiagnostics(body);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load diagnostics');
    }
  }, []);

  const loadRecentLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/system/logs/recent?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (Array.isArray(body.lines)) setLines(body.lines);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    loadDiagnostics();
    loadRecentLogs();
    const id = window.setInterval(loadDiagnostics, 5000);
    return () => window.clearInterval(id);
  }, [loadDiagnostics, loadRecentLogs]);

  useEffect(() => {
    const append = (line: ServerLogLine) => {
      setLines((prev) => [...prev.slice(-499), line]);
    };
    const unsubLog = subscribe('SERVER_LOG', append);
    const unsubOp = subscribe('REMOTE_OP_OUTPUT', (payload: { jobId: string; stream: string; line: string; ts: string }) => {
      append({
        id: `ws-op-${Date.now()}`,
        ts: payload.ts,
        level: payload.stream === 'stderr' ? 'error' : 'log',
        text: payload.line,
        source: 'remote-op',
        category: 'SCRIPT',
        jobId: payload.jobId,
        stream: payload.stream as 'stdout' | 'stderr',
      });
    });
    const unsubStatus = subscribe('REMOTE_OP_STATUS', () => {
      loadDiagnostics();
      setBusyJob(null);
    });
    return () => {
      unsubLog();
      unsubOp();
      unsubStatus();
    };
  }, [subscribe, loadDiagnostics]);

  useEffect(() => {
    if (!stickToBottom.current || !terminalRef.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [lines, filter]);

  const filteredLines = useMemo(
    () => lines.filter((l) => matchesFilter(l, filter)),
    [lines, filter],
  );

  const runJob = async (jobId: string) => {
    setBusyJob(jobId);
    setError(null);
    try {
      const res = await fetch('/api/v2/system/ops/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    } catch (e: any) {
      setBusyJob(null);
      setError(e?.message || 'Execute failed');
    }
  };

  const abortJob = async () => {
    try {
      const res = await fetch('/api/v2/system/ops/abort', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setBusyJob(null);
      loadDiagnostics();
    } catch (e: any) {
      setError(e?.message || 'Abort failed');
    }
  };

  const remoteRunning = diagnostics?.remoteOp?.status === 'running';

  return (
    <div className="flex flex-col gap-4 p-4 bg-[#0A0F16] min-h-full text-slate-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="text-indigo-400" size={18} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-white">Remote Ops</h2>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
          <span className={wsStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'}>
            WS {wsStatus}
          </span>
          <button
            type="button"
            onClick={() => { loadDiagnostics(); loadRecentLogs(); }}
            className="p-1.5 rounded border border-slate-700 hover:border-indigo-500/50"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-950/30 border border-rose-900/50 rounded p-2">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MetricCard icon={<Activity size={14} />} label="Uptime" value={diagnostics ? formatUptime(diagnostics.uptimeSec) : '—'} />
        <MetricCard
          icon={<Cpu size={14} />}
          label="Heap"
          value={diagnostics ? formatBytes(diagnostics.memory.heapUsed) : '—'}
        />
        <MetricCard
          icon={<Wifi size={14} />}
          label="WS Clients"
          value={diagnostics ? String(diagnostics.wsClientCount) : '—'}
        />
        <MetricCard
          icon={<Database size={14} />}
          label="DB Size"
          value={formatBytes(diagnostics?.dbSizeBytes ?? null)}
        />
      </div>

      {diagnostics?.alpaca && (
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 border border-slate-800 rounded p-2">
          Alpaca:{' '}
          <span className={diagnostics.alpaca.reachable ? 'text-emerald-400' : 'text-rose-400'}>
            {diagnostics.alpaca.configured
              ? diagnostics.alpaca.reachable
                ? `reachable (${diagnostics.alpaca.latencyMs}ms, ${diagnostics.alpaca.clockStatus})`
                : `unreachable${diagnostics.alpaca.error ? `: ${diagnostics.alpaca.error}` : ''}`
              : 'not configured'}
          </span>
        </div>
      )}

      <div className="grid gap-2">
        {(diagnostics?.allowedJobs ?? []).map((job) => (
          <div key={job.jobId} className="border border-slate-800 rounded-lg p-3 bg-[#111822] flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-bold font-mono text-indigo-300">{job.jobId}</div>
                <div className="text-[11px] text-slate-400 mt-1">{job.description}</div>
                <div className="text-[9px] text-slate-600 mt-1 uppercase tracking-widest">
                  timeout {Math.round(job.timeoutMs / 1000)}s
                </div>
              </div>
              <button
                type="button"
                disabled={remoteRunning || busyJob !== null}
                onClick={() => runJob(job.jobId)}
                className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600/20 border border-indigo-500/40 text-indigo-200 text-[10px] uppercase tracking-widest font-bold disabled:opacity-40"
              >
                <Play size={12} /> Run
              </button>
            </div>
          </div>
        ))}
      </div>

      {remoteRunning && (
        <button
          type="button"
          onClick={abortJob}
          className="flex items-center justify-center gap-2 py-2 rounded border border-rose-800 bg-rose-950/30 text-rose-300 text-xs uppercase tracking-widest font-bold"
        >
          <Square size={14} /> Abort {diagnostics?.remoteOp?.jobId}
        </button>
      )}

      <div className="flex flex-wrap gap-1">
        {(['ALL', 'TRADES', 'AI_DECISIONS', 'RISK_REJECTS', 'SYSTEM_ERRORS', 'SCRIPT_OUTPUT'] as MobileLogFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-2 py-1 rounded text-[9px] font-bold uppercase tracking-widest border mobile-press ${
              filter === f
                ? 'border-cyan-500/60 bg-cyan-950/40 text-cyan-200'
                : 'border-slate-800 text-slate-500 hover:border-slate-600'
            }`}
          >
            {f.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      <div
        ref={terminalRef}
        onScroll={() => {
          if (!terminalRef.current) return;
          const el = terminalRef.current;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-64 overflow-y-auto rounded border border-slate-800 bg-black/60 p-2 font-mono text-[11px] leading-relaxed"
      >
        {filteredLines.length === 0 ? (
          <div className="text-slate-600 uppercase tracking-widest text-[10px]">No log lines</div>
        ) : (
          filteredLines.map((line) => (
            <div key={line.id} className={`whitespace-pre-wrap break-all ${lineTone(line)}`}>
              <span className="text-slate-600 select-none">{line.ts.slice(11, 19)} </span>
              {line.jobId ? <span className="text-slate-500">[{line.jobId}] </span> : null}
              {compactLogLine(stripAnsi(line.text))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-[#111822] border border-slate-800 rounded p-2 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1 text-slate-500 text-[9px] uppercase tracking-widest font-bold">
        {icon}
        {label}
      </div>
      <div className="text-xs font-mono font-bold text-white truncate">{value}</div>
    </div>
  );
}

export default MobileOpsConsole;
