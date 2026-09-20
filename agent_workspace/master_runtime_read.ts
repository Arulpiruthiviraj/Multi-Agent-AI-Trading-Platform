import { buildCliAuthHeaders, defaultSessionFilePath } from '../scripts/cli/cliSession';
import { writeFileSync } from 'node:fs';
async function main() {
 const headers = buildCliAuthHeaders({sessionPath: defaultSessionFilePath(process.cwd())});
 const result: Record<string, unknown> = {capturedAt: new Date().toISOString()};
 for (const path of ['/api/v1/system/reconciliation/status','/api/v2/runtime/market/status','/api/v2/continuous-intelligence/status','/api/v1/portfolio','/api/v1/orders']) {
  try { const r = await fetch('http://127.0.0.1:3000'+path,{headers,signal:AbortSignal.timeout(10000)}); result[path]={http:r.status,body:await r.json()}; }
  catch(e) {result[path]={error:String(e)};}
 }
 writeFileSync(process.argv[2] || 'agent_workspace/master_runtime_snapshot.json',JSON.stringify(result,null,2));
 for (const [path,value] of Object.entries(result)) {
  if(path.includes('continuous-intelligence')) {const v:any=value;const slots=v.body?.activeSlots??[]; console.log(JSON.stringify({path,http:v.http,slots:slots.length,withTicks:slots.filter((s:any)=>s.tickCount>0).length,errors:slots.reduce((a:any,s:any)=>{const key=s.marketDataError?.code??'NO_ERROR';a[key]=(a[key]??0)+1;return a;},{})}));}
  else console.log(JSON.stringify({path,value}));
 }
}
main();
