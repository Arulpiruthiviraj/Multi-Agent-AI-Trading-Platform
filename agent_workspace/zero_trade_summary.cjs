const D = require('better-sqlite3');
const fs = require('node:fs');
const d = new D('data/argus.db',{readonly:true,fileMustExist:true});
const start = Date.parse('2026-09-17T04:00:00Z'), end = Date.parse('2026-09-18T04:00:00Z');
const parse = r => {const p=JSON.parse(r.payload||'{}');return {...r,p:p.payload||p};};
const events=d.prepare('SELECT * FROM event_traces WHERE timestamp>=? AND timestamp<? ORDER BY timestamp').all(start,end).map(parse);
const types=['CONSENSUS_TERMINAL_REASON','IBKR_MARKET_DATA_ERROR','DISCOVERY_CANDIDATE_ADMITTED','TECHNICAL_ANALYSIS_COMPLETED','QUANT_ASSESSMENT_COMPLETED','KRONOS_UNAVAILABLE','WATCHLIST_SUBSCRIBE_REQUESTED','SYMBOL_NOT_SUBSCRIBED','SUBSCRIPTION_PROMOTED','SUBSCRIPTION_EVICTED','TEMPORARY_DATA_RESCUE_GRANTED','TEMPORARY_DATA_RESCUE_DENIED'];
const obs=d.prepare(`SELECT ts,event_type,symbol,trace_id,payload,message FROM observability_events WHERE ts>=? AND ts<? AND event_type IN (${types.map(()=>'?').join(',')}) ORDER BY ts`).all(start,end,...types).map(parse);
const group=(rs,key)=>rs.reduce((a,r)=>{const k=key(r)??'UNKNOWN';a[k]=(a[k]||0)+1;return a;},{});
const term=obs.filter(r=>r.event_type==='CONSENSUS_TERMINAL_REASON');
const missing=events.filter(r=>r.event_type==='TRADE_IDEA_REJECTED'&&r.p.reason==='MISSING_PRICE');
const summarize=(cutoff)=>{
 const e=events.filter(r=>r.timestamp<=cutoff), t=term.filter(r=>r.ts<=cutoff), m=missing.filter(r=>r.timestamp<=cutoff);
 return {cutoff:new Date(cutoff).toISOString(),events:group(e,r=>r.event_type),missingEvents:m.length,missingSymbols:group(m,r=>r.p.symbol),missingAgents:group(m,r=>r.p.agent),terminalReasons:group(t,r=>r.p.terminalReasonCode),participantCount:group(t,r=>r.p.participatingAgents?.length),independentCount:group(t,r=>r.p.independentAgentCount),opposing:t.filter(r=>r.p.participatingAgents?.some(a=>a.side==='BUY')&&r.p.participatingAgents?.some(a=>a.side==='SELL')).length,independentBuy:t.filter(r=>r.p.independentAgentCount>=2&&r.p.participatingAgents?.some(a=>a.side==='BUY')).length,independentSell:t.filter(r=>r.p.independentAgentCount>=2&&r.p.participatingAgents?.some(a=>a.side==='SELL')).length,calibration:group(t.flatMap(r=>r.p.participatingAgents||[]),a=>a.calibrationDataQuality),maxFinalConfidence:Math.max(...t.map(r=>r.p.finalConfidence||0)),confidenceAtLeast75:t.filter(r=>r.p.finalConfidence>=.75).length};
};
const target=events.filter(r=>r.event_type==='CHIEF_CONSENSUS_STARTED')[1118]?.timestamp;
const report={window:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},currentDayEvents:d.prepare('SELECT count(*) n FROM event_traces WHERE timestamp>=?').get(end),full:summarize(end-1),at1119:target?summarize(target+1000):null};
report.snapshotAdditional={
 admissionEvents:obs.filter(r=>r.ts<=target+1000&&r.event_type==='DISCOVERY_CANDIDATE_ADMITTED').length,
 admittedSymbols:new Set(obs.filter(r=>r.ts<=target+1000&&r.event_type==='DISCOVERY_CANDIDATE_ADMITTED').map(r=>r.symbol)).size,
 roundsWithCalibratedEvidence:term.filter(r=>r.ts<=target+1000&&r.p.participatingAgents?.some(a=>a.calibrationDataQuality==='SUFFICIENT_CALIBRATION_DATA')).length,
 roundsWithoutKronosEvidence:term.filter(r=>r.ts<=target+1000&&!r.p.participatingAgents?.some(a=>a.agent==='KronosEngine')).length,
 aiByStatus:d.prepare('SELECT status,count(*) n FROM ai_calls WHERE created_at>=? AND created_at<=? GROUP BY status').all(new Date(start).toISOString(),new Date(target+1000).toISOString()),
};
report.lineage=missing.map(r=>{
 const s=r.p.symbol, history=obs.filter(o=>o.symbol===s&&o.ts<=r.timestamp), latest=type=>history.filter(o=>o.event_type===type).at(-1)||null;
 const error=latest('IBKR_MARKET_DATA_ERROR');
 return {eventId:r.id,traceId:r.correlation_id,symbol:s,at:new Date(r.timestamp).toISOString(),agent:r.p.agent,terminalReason:r.p.reason,discovery:latest('DISCOVERY_CANDIDATE_ADMITTED'),subscriptionRequest:latest('WATCHLIST_SUBSCRIBE_REQUESTED')||latest('SYMBOL_NOT_SUBSCRIBED'),brokerError:error,technical:latest('TECHNICAL_ANALYSIS_COMPLETED'),quant:latest('QUANT_ASSESSMENT_COMPLETED'),kronos:latest('KRONOS_UNAVAILABLE'),firstQuoteAt:null,lastQuoteAt:null,priceSource:null,assetClass:null,rank:null,activeLineAtRejection:null,rootCause:'UNRESOLVED_NO_QUOTE_LIFECYCLE_TELEMETRY',priorBrokerErrorCode:error?.p.code??null};
});
report.brokerErrors=group(obs.filter(r=>r.event_type==='IBKR_MARKET_DATA_ERROR'),r=>r.p.code);
for(const row of report.lineage) {
 row.rescue=obs.find(o=>o.trace_id===row.traceId&&o.event_type.startsWith('TEMPORARY_DATA_RESCUE_'))??null;
 if(row.rescue?.event_type==='TEMPORARY_DATA_RESCUE_DENIED') row.rootCause='RESCUE_DENIED:'+row.rescue.p.deniedReason;
 else if(row.rescue?.event_type==='TEMPORARY_DATA_RESCUE_GRANTED') row.rootCause='RESCUE_GRANTED_BUT_NO_FRESH_PRICE';
}
report.snapshotMissingReasons=group(report.lineage.filter(r=>Date.parse(r.at)<=target+1000),r=>r.rootCause);
report.snapshotPriorErrors=group(report.lineage.filter(r=>Date.parse(r.at)<=target+1000),r=>r.priorBrokerErrorCode);
report.priorErrorCoverage=group(report.lineage,r=>r.priorBrokerErrorCode);
report.subscriptionReasons=group(obs.filter(r=>r.event_type==='WATCHLIST_SUBSCRIBE_REQUESTED'),r=>r.p.reason);
report.technical={count:obs.filter(r=>r.event_type==='TECHNICAL_ANALYSIS_COMPLETED').length,last:obs.filter(r=>r.event_type==='TECHNICAL_ANALYSIS_COMPLETED').at(-1)};
report.discovery={admissions:obs.filter(r=>r.event_type==='DISCOVERY_CANDIDATE_ADMITTED').length,distinctSymbols:new Set(obs.filter(r=>r.event_type==='DISCOVERY_CANDIDATE_ADMITTED').map(r=>r.symbol)).size,largestGaps:obs.filter(r=>r.event_type==='DISCOVERY_CANDIDATE_ADMITTED'&&typeof r.p.gapPct==='number').sort((a,b)=>Math.abs(b.p.gapPct)-Math.abs(a.p.gapPct)).slice(0,10)};
report.providers=d.prepare('SELECT p.provider_name,c.status,c.agent,count(*) n FROM ai_calls c LEFT JOIN ai_providers p ON p.id=c.provider WHERE c.created_at>=? AND c.created_at<? GROUP BY p.provider_name,c.status,c.agent').all(new Date(start).toISOString(),new Date(end).toISOString());
report.consensusPersisted=d.prepare('SELECT approved,count(*) n FROM consensus_decisions WHERE created_at>=? AND created_at<? GROUP BY approved').all(new Date(start).toISOString(),new Date(end).toISOString());
fs.writeFileSync('agent_workspace/zero_trade_summary.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,lineage:undefined,providers:undefined,discovery:{...report.discovery,largestGaps:report.discovery.largestGaps.slice(0,2)}},null,2));
d.close();
