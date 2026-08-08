/**
 * ==========================================================
 * Module:
 * BrokerManagement.tsx
 *
 * Purpose:
 * Core implementation and logic for the BrokerManagement.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for BrokerManagementx
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import React, { useState, useEffect } from 'react';
import { Server, Settings, CheckCircle2, ShieldCheck, Database, Plus, RefreshCw, Trash2, Edit2, Play } from 'lucide-react';

export default function BrokerManagement() {
  const [loading, setLoading] = useState(false);
  const [globalDefaultBroker, setGlobalDefaultBroker] = useState('');
  React.useEffect(() => {
    fetch('/api/v1/config/settings')
      .then(r => r.json())
      .then(d => {
        if (d.selectedBroker) {
          setGlobalDefaultBroker(d.selectedBroker);
        }
      });
  }, []);

  const [brokerAccounts, setBrokerAccounts] = useState<any[]>([]);
   
   useEffect(() => {
     fetch('/api/v1/config/brokers')
       .then(res => res.json())
       .then(data => {
         setBrokerAccounts(data.map((b: any) => ({
           id: b.id, name: b.brokerName, type: 'Margin', mode: b.paperMode ? 'Paper' : 'Live', connected: b.status === 'Connected', sync: 'Just now', power: 100000, currency: 'USD'
         })));
       });
   }, []);

  return (
    <>

<style dangerouslySetInnerHTML={{ __html: `
.toggle-checkbox:checked {
  right: 0;
  border-color: #f59e0b; /* amber-500 */
}
.toggle-checkbox:checked + .toggle-label {
  background-color: #f59e0b;
}
` }} />


    <div className="flex flex-col gap-8 mb-8 font-mono">
      
      {/* Connected Brokers List */}
      <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-emerald-500">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Server size={14} className="text-emerald-500" /> Connected Broker Accounts
          </h3>
          <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-[10px] uppercase tracking-widest font-bold rounded transition-colors">
            <Plus size={12} /> Add Broker Account
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] text-slate-500 uppercase tracking-widest">
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Account Name</th>
                <th className="pb-3 font-medium">Type</th>
                <th className="pb-3 font-medium">Mode</th>
                <th className="pb-3 font-medium">Buying Power</th>
                <th className="pb-3 font-medium">Last Sync</th>
                <th className="pb-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {brokerAccounts.map((account) => (
                <tr key={account.id} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                  <td className="py-4">
                    {account.connected ? (
                      <CheckCircle2 size={14} className="text-emerald-500" />
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full border border-slate-600" />
                    )}
                  </td>
                  <td className="py-4 text-xs font-bold text-slate-200">{account.name}</td>
                  <td className="py-4 text-[10px] text-slate-400 uppercase tracking-wider">{account.type}</td>
                  <td className="py-4">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-widest ${account.mode === 'Live' ? 'bg-rose-500/10 text-rose-400' : 'bg-sky-500/10 text-sky-400'}`}>
                      {account.mode}
                    </span>
                  </td>
                  <td className="py-4 text-xs text-slate-300 font-bold">
                    {account.connected ? `${account.power.toLocaleString()} ${account.currency}` : '--'}
                  </td>
                  <td className="py-4 text-[10px] text-slate-500">{account.sync}</td>
                  <td className="py-4 flex justify-end gap-3 text-slate-500">
                    <button className="hover:text-sky-400 transition-colors" title="Test Connection"><Play size={14} /></button>
                    <button className="hover:text-emerald-400 transition-colors" title="Refresh Tokens"><RefreshCw size={14} /></button>
                    <button className="hover:text-indigo-400 transition-colors" title="Edit Configurations"><Edit2 size={14} /></button>
                    <button className="hover:text-rose-400 transition-colors" title="Delete Account"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Global Default Broker Selection */}
      <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-indigo-500">
        <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
          <Settings size={14} className="text-indigo-500" /> Global Default Broker
        </h3>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-6">
          Select the broker that will be used by default for all autonomous trading sessions unless explicitly overridden during launch.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {brokerAccounts.map((account) => {
            const isDefault = globalDefaultBroker === account.id;
            return (
              <label 
                key={account.id} 
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${isDefault ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-[#0A0F16] hover:border-slate-700'}`}
              >
                <input 
                  type="radio" 
                  name="defaultBroker" 
                  value={account.id} 
                  checked={isDefault}
                  onChange={() => setGlobalDefaultBroker(account.id)}
                  className="accent-indigo-500"
                />
                <div className="flex flex-col">
                  <span className={`text-xs font-bold ${isDefault ? 'text-indigo-400' : 'text-slate-300'}`}>{account.name}</span>
                  <span className="text-[10px] text-slate-500">{account.type} • {account.mode}</span>
                </div>
              </label>
            );
          })}
        </div>
        
        <div className="mt-4 flex items-center gap-2">
           <CheckCircle2 size={14} className="text-indigo-500" />
           <span className="text-[10px] text-slate-300 uppercase tracking-widest">Use this broker by default for all autonomous trading</span>
        </div>
      </div>


      {/* Broker Synchronization Settings */}
      <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-amber-500 mt-8">
        <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
          <RefreshCw size={14} className="text-amber-500" /> Broker Synchronization
        </h3>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-6">
          Configure automated re-sync intervals and view detailed error logs for failed synchronization attempts.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Settings */}
          <div>
            <h4 className="text-[10px] text-slate-500 uppercase tracking-widest mb-3 border-b border-slate-800 pb-2">Auto-Sync Configurations</h4>
            <div className="space-y-3">
              {brokerAccounts.map(account => (
                <div key={account.id} className="flex justify-between items-center bg-[#0A0F16] border border-slate-800 p-3 rounded">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-slate-300">{account.name}</span>
                    <span className="text-[9px] text-slate-500 uppercase tracking-widest">{account.mode}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <select className="bg-[#1A1F2B] border border-slate-700 text-[10px] text-slate-300 p-1.5 rounded outline-none">
                      <option>Off</option>
                      <option>Every 1 min</option>
                      <option>Every 5 mins</option>
                      <option>Every 15 mins</option>
                      <option>Every hour</option>
                    </select>
                    <div className="relative inline-block w-8 align-middle select-none transition duration-200 ease-in">
                      <input type="checkbox" name="toggle" className="toggle-checkbox absolute block w-4 h-4 rounded-full bg-white border-4 border-slate-600 appearance-none cursor-pointer checked:right-0 checked:border-amber-500" defaultChecked={account.connected}/>
                      <label className="toggle-label block overflow-hidden h-4 rounded-full bg-slate-700 cursor-pointer"></label>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Logs */}
          <div>
             <h4 className="text-[10px] text-slate-500 uppercase tracking-widest mb-3 border-b border-slate-800 pb-2">Recent Synchronization Logs</h4>
             <div className="bg-[#0A0F16] border border-slate-800 rounded p-3 h-64 overflow-y-auto font-mono text-[10px]">
                <div className="text-emerald-400 mb-2">[SUCCESS] Alpaca Paper: Token refreshed. Sync completed in 140ms.</div>
                <div className="text-emerald-400 mb-2">[SUCCESS] Interactive Brokers Paper: Orders synchronized. Sync completed in 320ms.</div>
                <div className="text-rose-400 mb-2">[ERROR] Robinhood: Authentication failed. Invalid API credentials or token expired. Please re-authenticate.</div>
                <div className="text-emerald-400 mb-2">[SUCCESS] Questrade Margin: Portfolio balances synced.</div>
                <div className="text-emerald-400 mb-2">[SUCCESS] Coinbase: Market data WebSocket heartbeat acknowledged.</div>
                <div className="text-amber-400 mb-2">[WARN] Questrade TFSA: Rate limit approaching (95/100 requests per minute). Backing off for 15s.</div>
                <div className="text-rose-400 mb-2">[ERROR] Robinhood: Failed to fetch active positions. Reason: Connection refused.</div>
             </div>
          </div>
        </div>
      </div>

    </div>
    </>
  );
}
