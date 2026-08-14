/**
 * ==========================================================
 * Module: SystemValidationSuite
 *
 * This used to simulate a 17-test "acceptance suite" against a fictional "STAGING-ENV" running
 * "Mock SQLite", where every test's pass/fail was `(Date.now() % 1000 / 1000) > 0.1` - a
 * deterministic ~90%-pass RNG with zero relationship to the real system's actual state - plus a
 * hardcoded "Root Cause"/"Recommended Fix" narrative shown whenever the RNG happened to fail one.
 *
 * Now backed entirely by GET /api/v1/system/integrity (IntegrityValidator.ts, already real,
 * previously only reachable via direct API call) - real structural checks against the actual
 * live database, real broker capability objects, real AI/news provider registration, and a real
 * reachability probe of the local Chronos/FinBERT service. A check that cannot determine a real
 * answer reports UNKNOWN, never a fabricated PASS.
 * ==========================================================
 */

import React, { useState } from "react";
import { CheckCircle2, XCircle, HelpCircle, Play, RefreshCw, Server, Activity, ShieldCheck, FileText, ShieldAlert } from "lucide-react";

interface IntegrityCheck {
  id: string;
  description: string;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  detail: string;
}

interface IntegrityReport {
  timestamp: string;
  checks: IntegrityCheck[];
  score: string;
  scorePct: number;
}

export function SystemValidationSuite() {
  const [isRunning, setIsRunning] = useState(false);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runChecks = () => {
    setIsRunning(true);
    setError(null);
    fetch('/api/v1/system/integrity')
      .then(r => r.json())
      .then((json: IntegrityReport) => {
        setReport(json);
        setIsRunning(false);
      })
      .catch(e => {
        setError(e.message);
        setIsRunning(false);
      });
  };

  const passed = report?.checks.filter(c => c.status === 'PASS').length ?? 0;
  const failed = report?.checks.filter(c => c.status === 'FAIL').length ?? 0;
  const unknown = report?.checks.filter(c => c.status === 'UNKNOWN').length ?? 0;

  return (
    <div className="flex flex-col gap-6 animate-fade-in pb-10">

      {/* Header */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative z-10">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              <ShieldCheck className="text-emerald-400" size={28} />
              System Integrity Checks
            </h1>
            <p className="text-slate-400 text-sm mt-1">Real structural checks against the live system - schema, brokers, AI/news providers, local AI service reachability. Not a business-logic test run (see the real unit/integration test suite for that).</p>
          </div>

          <button
            onClick={runChecks}
            disabled={isRunning}
            className={`px-6 py-3 rounded-lg font-bold text-sm flex items-center gap-2 transition-all ${
              isRunning
                ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)]"
            }`}
          >
            {isRunning ? (
              <><RefreshCw size={16} className="animate-spin" /> Running Real Checks...</>
            ) : (
              <><Play size={16} /> Run Integrity Checks</>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-sm text-rose-300 flex items-center gap-2">
          <ShieldAlert size={16} /> Request failed: {error}
        </div>
      )}

      {!report && !error && !isRunning && (
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-10 text-center text-sm font-mono text-slate-500 uppercase tracking-widest">
          Click "Run Integrity Checks" for a real report - nothing runs automatically here.
        </div>
      )}

      {report && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Check List */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl overflow-hidden shadow-sm flex flex-col">
              <div className="p-4 bg-slate-800/50 border-b border-slate-800 flex justify-between items-center">
                <h3 className="font-bold text-slate-200 text-sm uppercase tracking-widest flex items-center gap-2">
                  <Activity size={16} className="text-indigo-400" /> Real Integrity Checks
                </h3>
                <span className="text-xs text-slate-400 font-mono bg-slate-900 px-2 py-1 rounded">
                  Total: {report.checks.length}
                </span>
              </div>

              <div className="p-2 space-y-2">
                {report.checks.map((check) => (
                  <div
                    key={check.id}
                    className={`p-4 rounded-lg border transition-colors flex items-start gap-4 ${
                      check.status === "PASS" ? "bg-emerald-500/5 border-emerald-500/20" :
                      check.status === "FAIL" ? "bg-rose-500/5 border-rose-500/20" :
                      "bg-slate-800/30 border-slate-800"
                    }`}
                  >
                    <div className="pt-0.5">
                      {check.status === "PASS" ? <CheckCircle2 size={18} className="text-emerald-500" /> :
                       check.status === "FAIL" ? <XCircle size={18} className="text-rose-500" /> :
                       <HelpCircle size={18} className="text-slate-500" />}
                    </div>

                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className={`text-sm font-bold ${check.status === "FAIL" ? "text-rose-400" : "text-slate-200"}`}>
                          {check.description}
                        </h4>
                        <span className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded ${
                          check.status === "PASS" ? "bg-emerald-500/10 text-emerald-400" :
                          check.status === "FAIL" ? "bg-rose-500/10 text-rose-400" :
                          "bg-slate-800 text-slate-500"
                        }`}>
                          {check.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono">{check.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Status / Report Column */}
          <div className="space-y-6">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Server size={14} className="text-indigo-400" /> Real Report Summary
              </h3>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-[#111822] p-3 rounded-lg border border-slate-800 text-center">
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Passed</div>
                  <div className="text-2xl font-bold text-emerald-400">{passed}</div>
                </div>
                <div className="bg-[#111822] p-3 rounded-lg border border-slate-800 text-center">
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Failed</div>
                  <div className="text-2xl font-bold text-rose-400">{failed}</div>
                </div>
                <div className="bg-[#111822] p-3 rounded-lg border border-slate-800 text-center">
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Unknown</div>
                  <div className="text-2xl font-bold text-slate-400">{unknown}</div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Score (scored checks only)</span>
                  <span className="text-slate-200 font-mono">{report.score} ({report.scorePct}%)</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Checked at</span>
                  <span className="text-slate-200 font-mono">{new Date(report.timestamp).toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className={`bg-[#1A1F2B] border rounded-xl p-5 shadow-sm relative overflow-hidden ${failed === 0 ? 'border-emerald-500/30' : 'border-amber-500/30'}`}>
              <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2 relative z-10">
                <FileText size={16} className={failed === 0 ? "text-emerald-400" : "text-amber-400"} />
                What This Checks - and What It Doesn't
              </h3>
              <p className="text-xs text-slate-300 relative z-10">
                Scope is deliberately narrow: structural presence and reachability (schema tables exist, brokers expose real capability flags, AI/news providers are seeded, the local AI service answers). It does not verify business-logic correctness - that is what the real unit/integration test suite (<code>npm test</code>) covers, not this page.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
