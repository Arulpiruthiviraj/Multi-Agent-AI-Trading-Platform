// READ-ONLY (Oct 14 snapshot): is ungraded prediction history being deleted by retention before the grader reaches it?
const D = require('C:/WorkProjects/Multi-Agent-AI-Trading-Platform/node_modules/better-sqlite3');
const fs = require('fs');
const db = new D('C:/Users/ithay/AppData/Local/Temp/J/db_backup/argus_oct14_postclose_1792008436014.db', { readonly: true, fileMustExist: true });
const SNAP_MS = Date.parse('2026-10-14T20:07:15Z'); const RET_DAYS = 30; const DAY = 86400e3;
const out = { snapshotAt: new Date(SNAP_MS).toISOString(), retentionDays: RET_DAYS };
const save = () => fs.writeFileSync('C:/Users/ithay/AppData/Local/Temp/J/grading_retention_audit.json', JSON.stringify(out, null, 1));
const bucket = (ageDays) => ageDays < 1 ? '0-1d' : ageDays < 7 ? '1-7d' : ageDays < 14 ? '7-14d' : ageDays < 23 ? '14-23d' : ageDays < 29 ? '23-29d' : '29-30d+';

// 1. agent_predictions (all non-Kronos agents): pending by agent and age
const pend = db.prepare(`select ap.agent_name a, ap.timestamp ts from agent_predictions ap left join prediction_outcomes po on po.prediction_id=ap.id and po.source_table='agent_predictions' where po.id is null and ap.agent_name<>'KronosEngine' and ap.trace_id not like 'telemetry%'`);
const byAgent = {};
for (const r of pend.iterate()) { const age = (SNAP_MS - Date.parse(r.ts)) / DAY; const k = r.a; const e = (byAgent[k] ||= { pending: 0, oldestDays: 0, byAge: {}, expireWithin1d: 0, expireWithin7d: 0 }); e.pending++; e.oldestDays = Math.max(e.oldestDays, age); const b = bucket(age); e.byAge[b] = (e.byAge[b] || 0) + 1; const left = RET_DAYS - age; if (left <= 1) e.expireWithin1d++; if (left <= 7) e.expireWithin7d++; }
out.agentPredictionsPending = Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, { ...v, oldestDays: +v.oldestDays.toFixed(1) }]));
save();
// 2. kronos_predictions pending
const kp = db.prepare(`select kp.timestamp ts from kronos_predictions kp left join prediction_outcomes po on po.prediction_id=cast(kp.id as text) and po.source_table='kronos_predictions' where po.id is null`);
const k = { pending: 0, oldestDays: 0, byAge: {}, expireWithin1d: 0, expireWithin7d: 0 };
for (const r of kp.iterate()) { const age = (SNAP_MS - Date.parse(r.ts)) / DAY; k.pending++; k.oldestDays = Math.max(k.oldestDays, age); const b = bucket(age); k.byAge[b] = (k.byAge[b] || 0) + 1; const left = RET_DAYS - age; if (left <= 1) k.expireWithin1d++; if (left <= 7) k.expireWithin7d++; }
k.oldestDays = +k.oldestDays.toFixed(1);
out.kronosPending = k; save();
// 3. generation per day vs grading per day (last 21 days)
out.generationPerDay = {
  agent_predictions_nonKronos: db.prepare("select substr(timestamp,1,10) d, count(*) c from agent_predictions where agent_name<>'KronosEngine' group by d order by d desc limit 21").all().reverse(),
  kronos_predictions: db.prepare("select substr(timestamp,1,10) d, count(*) c from kronos_predictions group by d order by d desc limit 21").all().reverse(),
};
out.gradedPerDayByEvaluationDate = db.prepare("select substr(evaluated_at,1,10) d, source_table s, count(*) c from prediction_outcomes where source_table in ('agent_predictions','kronos_predictions') group by d, s order by d desc limit 40").all().reverse();
save();
// 4. age of the predictions graded most recently (what is the grader reaching?)
out.ageAtGradingOct14 = db.prepare(`select 'agent_predictions' src, round(avg((julianday(substr(po.evaluated_at,1,19)) - julianday(substr(ap.timestamp,1,19)))),1) avgAgeDays, round(min((julianday(substr(po.evaluated_at,1,19)) - julianday(substr(ap.timestamp,1,19)))),1) minAge, round(max((julianday(substr(po.evaluated_at,1,19)) - julianday(substr(ap.timestamp,1,19)))),1) maxAge, count(*) n from prediction_outcomes po join agent_predictions ap on ap.id=po.prediction_id where po.source_table='agent_predictions' and po.evaluated_at>='2026-10-14'`).get();
out.ageAtGradingKronosOct14 = db.prepare(`select round(avg(julianday(substr(po.evaluated_at,1,19)) - julianday(substr(kp.timestamp,1,19))),1) avgAgeDays, round(min(julianday(substr(po.evaluated_at,1,19)) - julianday(substr(kp.timestamp,1,19))),1) minAge, round(max(julianday(substr(po.evaluated_at,1,19)) - julianday(substr(kp.timestamp,1,19))),1) maxAge, count(*) n from prediction_outcomes po join kronos_predictions kp on cast(kp.id as text)=po.prediction_id where po.source_table='kronos_predictions' and po.evaluated_at>='2026-10-13'`).get();
save();
// 5. do outcomes survive deletion of the raw predictions? (orphan outcomes = graded rows whose raw prediction was already deleted)
out.outcomeSurvival = {
  agent_orphans: db.prepare("select count(*) c from prediction_outcomes po where po.source_table='agent_predictions' and not exists (select 1 from agent_predictions ap where ap.id=po.prediction_id)").get().c,
  agent_total: db.prepare("select count(*) c from prediction_outcomes where source_table='agent_predictions'").get().c,
  kronos_orphans: db.prepare("select count(*) c from prediction_outcomes po where po.source_table='kronos_predictions' and not exists (select 1 from kronos_predictions kp where cast(kp.id as text)=po.prediction_id)").get().c,
  kronos_total: db.prepare("select count(*) c from prediction_outcomes where source_table='kronos_predictions'").get().c,
  earliestRawAgentPrediction: db.prepare("select min(timestamp) t from agent_predictions").get().t,
  earliestRawKronosPrediction: db.prepare("select min(timestamp) t from kronos_predictions").get().t,
  earliestOutcomeEvaluated: db.prepare("select min(evaluated_at) t from prediction_outcomes").get().t,
  outcomeRetentionDays: 90,
};
out.done = true; save(); console.log('DONE');
