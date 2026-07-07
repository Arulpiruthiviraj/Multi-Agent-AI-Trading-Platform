const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const auditLogStateStr = 'const [auditLogs, setAuditLogs] = useState<any[]>([]);';
code = code.replace(auditLogStateStr, auditLogStateStr + '\\n  const [isAutoScrollAudit, setIsAutoScrollAudit] = useState(true);\\n');

const oldLogsHeader = \`<div className="flex gap-2">
                    <select className="bg-[#111822] border border-slate-800 rounded text-[10px] font-mono text-slate-300 py-1.5 px-3">
                       <option>System Metrics & Errors</option>
                       <option>Agent Communications</option>
                       <option>Broker Connectivity</option>
                    </select>
                    <button className="bg-[#111822] hover:bg-slate-800 text-slate-300 border border-slate-700 py-1.5 px-3 rounded text-[10px] font-bold font-mono tracking-wider flex items-center gap-2 transition-colors">
                      <Download size={12}/>
                      EXPORT LOGS (CSV)
                    </button>
                  </div>\`;

const newLogsHeader = \`<div className="flex gap-2">
                    <select className="bg-[#111822] border border-slate-800 rounded text-[10px] font-mono text-slate-300 py-1.5 px-3">
                       <option>System Metrics & Errors</option>
                       <option>Agent Communications</option>
                       <option>Broker Connectivity</option>
                    </select>
                    <button onClick={() => setIsAutoScrollAudit(!isAutoScrollAudit)} className={"py-1.5 px-3 rounded text-[10px] font-bold font-mono tracking-wider flex items-center gap-2 transition-colors " + (isAutoScrollAudit ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/30" : "bg-[#111822] border border-slate-700 text-slate-300 hover:bg-slate-800")}>
                      {isAutoScrollAudit ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                      AUTO-SCROLL
                    </button>
                    <button onClick={() => setAuditLogs([])} className="bg-[#111822] hover:bg-slate-800 text-slate-300 border border-slate-700 py-1.5 px-3 rounded text-[10px] font-bold font-mono tracking-wider flex items-center gap-2 transition-colors">
                      <Trash2 size={12}/>
                      CLEAR LOG
                    </button>
                    <button className="bg-[#111822] hover:bg-slate-800 text-slate-300 border border-slate-700 py-1.5 px-3 rounded text-[10px] font-bold font-mono tracking-wider flex items-center gap-2 transition-colors">
                      <Download size={12}/>
                      EXPORT
                    </button>
                  </div>\`;

code = code.replace(oldLogsHeader, newLogsHeader);

const oldLogsContent = \`<div className="flex-1 bg-black/40 border border-slate-800 rounded-lg p-4 font-mono text-[10px] text-slate-400 overflow-y-auto max-h-[600px] whitespace-pre-wrap flex flex-col gap-2">
                  <div>
                    <span className="text-slate-500">[2024-03-12T08:44:12Z]</span> <span className="text-sky-400 font-bold">INFO</span> <span className="text-indigo-400">[RiskManager]</span> Assessing trade safety limits...
                  </div>
                  <div className="text-emerald-400">
                    &#123;<br/>
                    &nbsp;&nbsp;"exposure_level": 0.44,<br/>
                    &nbsp;&nbsp;"confidence_score": 88<br/>
                    &#125;
                  </div>
                  <div>
                    <span className="text-slate-500">[2024-03-12T08:44:12Z]</span> <span className="text-emerald-400 font-bold">SUCCESS</span> <span className="text-indigo-400">[OrderBroker]</span> 100 shares AAPL filled at $168.45.
                  </div>
                  <div className="mt-2 text-slate-600">... Awaiting further events ...</div>
                </div>\`;

const newLogsContent = \`<div className="flex-1 bg-black/40 border border-slate-800 rounded-lg p-4 font-mono text-[10px] text-slate-400 overflow-y-auto max-h-[600px] whitespace-pre-wrap flex flex-col gap-2">
                   {auditLogs.length === 0 ? (
                      <div className="text-slate-600">... Awaiting further events ...</div>
                   ) : (
                      auditLogs.map((log, i) => (
                         <div key={log.id || i}>
                           <span className="text-slate-500">[{new Date(log.timestamp || Date.now()).toISOString()}]</span> <span className="text-sky-400 font-bold">{log.action || "INFO"}</span> <span className="text-indigo-400">[{log.symbol || "System"}]</span> {log.headline || "Log event recorded."}
                           {log.details && (
                             <pre className="text-emerald-400 mt-1 font-mono text-[10px] bg-[#111822] p-2 rounded border border-slate-800">
                               {JSON.stringify(log.details, null, 2)}
                             </pre>
                           )}
                         </div>
                      ))
                   )}
                   {isAutoScrollAudit && <div ref={(el) => { el?.scrollIntoView({ behavior: 'smooth' }); }} />}
                </div>\`;

code = code.replace(oldLogsContent, newLogsContent);

const replacement = \`const [auditLogs, setAuditLogs] = useState<any[]>([
      {
        id: "AL-1",
        timestamp: "2024-03-12T08:44:12Z",
        action: "INFO",
        symbol: "RiskManager",
        headline: "Assessing trade safety limits...",
        details: {
          exposure_level: 0.44,
          confidence_score: 88,
        }
      },
      {
        id: "AL-2",
        timestamp: "2024-03-12T08:44:12Z",
        action: "SUCCESS",
        symbol: "OrderBroker",
        headline: "100 shares AAPL filled at $168.45."
      }
    ]);\`;

code = code.replace('const [auditLogs, setAuditLogs] = useState<any[]>([]);', replacement);

fs.writeFileSync('src/App.tsx', code);
