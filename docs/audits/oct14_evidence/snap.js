const D=require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const t=new Date().toISOString();
const src=new D('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/data/argus.db',{readonly:true,fileMustExist:true});
const out='C:/Users/ithay/AppData/Local/Temp/J/db_backup/argus_oct14_postclose_'+Date.now()+'.db';
const t0=Date.now();
src.backup(out,{progress:({totalPages,remainingPages})=>totalPages}).then(()=>{console.log(JSON.stringify({startedAt:t,finishedAt:new Date().toISOString(),sec:(Date.now()-t0)/1000,out}));src.close()}).catch(e=>{console.log('FAILED',e.message);process.exit(1)});
