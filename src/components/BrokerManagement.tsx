/**
 * BrokerManagement.tsx - real broker capability/connection management.
 *
 * Rebuilt against BrokerManager's real capability model (Batch 3.5A / Phase 5). Previously this
 * screen fabricated buying power ("100000" hardcoded), fabricated "Just now" sync timestamps,
 * non-functional Test/Refresh/Edit/Delete buttons, and a static synchronization log that
 * literally mentioned "Robinhood" - a broker with no adapter file in this codebase at all.
 *
 * Every value below comes from a real API call. Nothing here is simulated.
 */
import React, { useState, useEffect } from 'react';
import { Server, Settings, CheckCircle2, XCircle, Plus, RefreshCw, Play, AlertTriangle, ShieldAlert, Radio } from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext';

interface BrokerCapabilities {
  canPlaceOrders: boolean;
  canCancelOrders: boolean;
  paperTrading: boolean;
  liveTrading: boolean;
  usEquities: boolean;
  canadianEquities: boolean;
  crypto: boolean;
  options: boolean;
  shortSelling: boolean;
  streamingMarketData: boolean;
  requiresManualReauth: boolean;
}

interface BrokerEntry {
  id: string;
  name: string;
  capabilities: BrokerCapabilities;
}

interface ReconciliationLogEntry {
  id: string;
  timestamp: string;
  type: 'match' | 'mismatch';
  broker: string;
  detail: string;
}

function CapabilityPill({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
      {label}
    </span>
  );
}

export default function BrokerManagement() {
  const { subscribe } = useWebSocket();
  const [brokers, setBrokers] = useState<BrokerEntry[]>([]);
  const [activeBrokerId, setActiveBrokerId] = useState<string>('');
  const [savedConnections, setSavedConnections] = useState<any[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; health: string; error?: string; testing?: boolean }>>({});
  const [reconciliationLog, setReconciliationLog] = useState<ReconciliationLogEntry[]>([]);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [addForm, setAddForm] = useState({ brokerName: 'Alpaca', apiKeyEncrypted: '', apiSecretEncrypted: '', paperMode: true });
  const [addStatus, setAddStatus] = useState<string | null>(null);

  const refresh = () => {
    fetch('/api/v1/broker-capabilities').then(r => r.json()).then(data => {
      setBrokers(data.brokers || []);
      setActiveBrokerId(data.activeBroker || '');
    }).catch(() => {});
    fetch('/api/v1/config/brokers').then(r => r.json()).then(data => {
      setSavedConnections(Array.isArray(data) ? data : []);
    }).catch(() => {});
  };

  useEffect(() => { refresh(); }, []);

  // Real reconciliation events (Phase 4) - replaces the old static fabricated sync log.
  useEffect(() => {
    const unsubMismatch = subscribe('RECONCILIATION_MISMATCH', (data: any) => {
      setReconciliationLog(prev => [{
        id: `${data.timestamp}-${Math.random()}`,
        timestamp: data.timestamp,
        type: 'mismatch',
        broker: data.broker,
        detail: `${data.mismatches?.length || 0} mismatch(es), worst impact ~$${data.worstImpactDollars ?? '?'}`,
      }, ...prev].slice(0, 50));
    });
    const unsubMatch = subscribe('RECONCILIATION_MATCH', (data: any) => {
      setReconciliationLog(prev => [{
        id: `${data.timestamp}-${Math.random()}`,
        timestamp: data.timestamp,
        type: 'match',
        broker: data.broker,
        detail: 'Positions reconciled, no drift.',
      }, ...prev].slice(0, 50));
    });
    return () => { unsubMismatch(); unsubMatch(); };
  }, [subscribe]);

  const setActive = async (id: string) => {
    setSwitching(id);
    try {
      const res = await fetch('/api/v1/brokers/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!data.success) {
        if (data.error) {
          // setActiveBroker() already threw a specific, real reason (e.g. Questrade: "not a
          // functional adapter - Refusing to select it as active") - show it directly rather
          // than discarding it in favor of a generic re-check.
          setTestResults(prev => ({ ...prev, [id]: { ok: false, health: 'Offline', error: data.error } }));
        } else {
          // No detail was given (setActiveBroker() returned false with no throw, e.g. a broker
          // whose authenticate() just failed) - reuse the real testConnection() call every broker
          // already has, which returns this specific broker's actual health/error, instead of
          // guessing a broker-specific reason (the old version hardcoded an IBKR-flavored message
          // and showed it under every broker, including Coinbase, which has no gateway at all).
          await testConnection(id);
        }
      }
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [id]: { ok: false, health: 'Offline', error: e.message } }));
    } finally {
      setSwitching(null);
      refresh();
    }
  };

  const testConnection = async (id: string) => {
    setTestResults(prev => ({ ...prev, [id]: { ...(prev[id] || { ok: false, health: 'Offline' }), testing: true } }));
    try {
      const res = await fetch(`/api/v1/brokers/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [id]: { ...data, testing: false } }));
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [id]: { ok: false, health: 'Offline', error: e.message, testing: false } }));
    }
  };

  const submitAddConnection = async () => {
    setAddStatus('Saving...');
    try {
      const res = await fetch('/api/v1/config/brokers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      });
      const data = await res.json();
      if (data.ok) {
        setAddStatus('Saved. Restart the server for AIRouter/BrokerManager to pick up a newly-added connection at boot, or use "Set Active" for adapters that read credentials at authenticate() time.');
        refresh();
      } else {
        setAddStatus(`Failed: ${data.error || 'unknown error'}`);
      }
    } catch (e: any) {
      setAddStatus(`Failed: ${e.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-8 mb-8 font-mono">

      {/* Registered Broker Adapters - the real capability model */}
      <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-emerald-500">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Server size={14} className="text-emerald-500" /> Registered Broker Adapters
          </h3>
          <button onClick={() => setAddFormOpen(v => !v)} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-[10px] uppercase tracking-widest font-bold rounded transition-colors">
            <Plus size={12} /> Add / Update Credentials
          </button>
        </div>
        <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-4">
          canPlaceOrders reflects whether the adapter's code implements real order placement per the broker's official API - not whether it has been live-tested this session. Never claims a capability the code doesn't actually implement.
        </p>

        {addFormOpen && (
          <div className="bg-[#0A0F16] border border-slate-800 rounded p-4 mb-5 flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <select value={addForm.brokerName} onChange={e => setAddForm({ ...addForm, brokerName: e.target.value })} className="bg-[#111822] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-300 outline-none">
                {brokers.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
              </select>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={addForm.paperMode} onChange={e => setAddForm({ ...addForm, paperMode: e.target.checked })} /> Paper mode
              </label>
              <input placeholder="API Key" value={addForm.apiKeyEncrypted} onChange={e => setAddForm({ ...addForm, apiKeyEncrypted: e.target.value })} className="bg-[#111822] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-300 outline-none" />
              <input placeholder="API Secret" type="password" value={addForm.apiSecretEncrypted} onChange={e => setAddForm({ ...addForm, apiSecretEncrypted: e.target.value })} className="bg-[#111822] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-300 outline-none" />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={submitAddConnection} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold uppercase tracking-widest rounded">Save (encrypted at rest)</button>
              {addStatus && <span className="text-[10px] text-slate-400">{addStatus}</span>}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {brokers.map(b => {
            const isActive = b.id === activeBrokerId;
            const test = testResults[b.id];
            // GET /api/v1/brokers no longer returns apiKeyEncrypted ciphertext (real credential-leak
            // fix) - it returns hasApiKey instead, computed server-side from the same real value.
            const hasSavedCreds = savedConnections.some((c: any) => c.brokerName === b.name && c.hasApiKey);
            return (
              <div key={b.id} className={`border rounded-lg p-4 ${isActive ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-slate-800 bg-[#0A0F16]'}`}>
                <div className="flex justify-between items-start flex-wrap gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      {isActive ? <CheckCircle2 size={14} className="text-emerald-500" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-600" />}
                      <span className="text-sm font-bold text-slate-100">{b.name}</span>
                      {isActive && <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">ACTIVE</span>}
                      {hasSavedCreds && <span className="text-[9px] font-bold uppercase tracking-widest text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded">CREDENTIALS SAVED</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <CapabilityPill label="Place Orders" ok={b.capabilities.canPlaceOrders} />
                      <CapabilityPill label="Cancel Orders" ok={b.capabilities.canCancelOrders} />
                      <CapabilityPill label="Paper" ok={b.capabilities.paperTrading} />
                      <CapabilityPill label="Live" ok={b.capabilities.liveTrading} />
                      <CapabilityPill label="US Equities" ok={b.capabilities.usEquities} />
                      <CapabilityPill label="Canadian Equities" ok={b.capabilities.canadianEquities} />
                      <CapabilityPill label="Crypto" ok={b.capabilities.crypto} />
                      {b.capabilities.requiresManualReauth && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 flex items-center gap-1">
                          <ShieldAlert size={9} /> Needs periodic human 2FA login
                        </span>
                      )}
                      {!b.capabilities.canPlaceOrders && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-400 flex items-center gap-1">
                          <XCircle size={9} /> Not a functional trading adapter
                        </span>
                      )}
                    </div>
                    {b.id === 'ibkr' && (
                      <p className="text-[9px] text-slate-500 mt-2 max-w-lg">
                        Canadian equities are disabled regardless of session state - IBKR Canada retail accounts are barred from API order submission on TSX/TSXV-listed symbols by IIROC Dealer Member Rule 3200A.1(b)(i). US-listed symbols are unaffected.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className="flex gap-2">
                      <button
                        onClick={() => testConnection(b.id)}
                        disabled={test?.testing}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold uppercase tracking-widest rounded transition-colors disabled:opacity-50"
                      >
                        <Play size={11} /> {test?.testing ? 'Testing...' : 'Test Connection'}
                      </button>
                      <button
                        onClick={() => setActive(b.id)}
                        disabled={isActive || switching === b.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-[10px] font-bold uppercase tracking-widest rounded transition-colors"
                      >
                        {switching === b.id ? 'Switching...' : isActive ? 'Active' : 'Set Active'}
                      </button>
                    </div>
                    {test && (
                      <div className={`text-[10px] max-w-xs text-right ${test.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {test.ok ? `Connected - health: ${test.health}` : (test.error || `Not connected - health: ${test.health}`)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Real reconciliation event log - replaces the old static/fabricated sync log */}
      <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-amber-500">
        <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-2 flex items-center gap-2">
          <Radio size={14} className="text-amber-500" /> Live Portfolio Reconciliation Feed
        </h3>
        <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-4">
          Real RECONCILIATION_MATCH/RECONCILIATION_MISMATCH events from PortfolioReconciliationWorker, streamed over the same WebSocket the rest of the app uses. This worker only runs while the autonomous engine is active - the feed will be empty otherwise, which is the honest state, not an error.
        </p>
        <div className="bg-[#0A0F16] border border-slate-800 rounded p-3 h-56 overflow-y-auto font-mono text-[10px]">
          {reconciliationLog.length === 0 ? (
            <div className="text-slate-600 italic text-center py-8">No reconciliation events yet. Enable the autonomous engine to start the 5-minute reconciliation cycle.</div>
          ) : (
            reconciliationLog.map(entry => (
              <div key={entry.id} className={`mb-2 ${entry.type === 'mismatch' ? 'text-rose-400' : 'text-emerald-400'}`}>
                [{entry.type === 'mismatch' ? 'MISMATCH' : 'MATCH'}] {new Date(entry.timestamp).toLocaleTimeString()} {entry.broker}: {entry.detail}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
