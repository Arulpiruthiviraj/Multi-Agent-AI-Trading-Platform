import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { replaySafety } from '../replay/replaySafety';

describe('checkpoint real policy activity evidence', () => {
  let sqliteDb: InstanceType<typeof Database>;
  let read: (start: number, end: number) => Promise<number>;
  const tmp = path.join(os.tmpdir(), `argus-checkpoint-policy-${process.pid}-${Date.now()}.db`);
  const previous = process.env.ARGUS_DB_PATH;
  beforeAll(async () => {
    process.env.ARGUS_DB_PATH = tmp;
    ({ sqliteDb } = await import('../db'));
    ({ readObservedQuantPolicyEvaluations: read } = await import('./sessionCheckpoint'));
    const insert = sqliteDb.prepare('INSERT INTO observability_events (id,ts,level,category,event_type,logger_name,message,session_id,trace_id) VALUES (?,?,?,?,?,?,?,?,?)');
    const add = (id: string, ts: number, type: string, trace: string | null) => insert.run(id,ts,'INFO','CONSENSUS',type,'fixture','fixture','isolated',trace);
    add('approved-start',100,'QUANT_POLICY_APPROVED','organic-a');
    add('rejected-inside',199,'QUANT_POLICY_REJECTED','organic-b');
    add('approved-end',200,'QUANT_POLICY_APPROVED','organic-c');
    add('too-old',99,'QUANT_POLICY_APPROVED','organic-d');
    add('replay',150,'QUANT_POLICY_APPROVED',`${replaySafety.replayTracePrefix}fixture`);
    add('authorization-only',150,'STRATEGY_AUTHORIZATION_CHECKED','organic-e');
    add('null-trace',150,'QUANT_POLICY_REJECTED',null);
  });
  afterAll(() => {
    sqliteDb?.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmp+suffix,{force:true});
    if(previous === undefined) delete process.env.ARGUS_DB_PATH; else process.env.ARGUS_DB_PATH=previous;
  });
  it('counts real policy results within the exact window, excluding replay and authorization-only activity', async () => {
    const before=sqliteDb.prepare('SELECT count(*) AS n FROM observability_events').get();
    expect(await read(100,200)).toBe(3);
    expect(sqliteDb.prepare('SELECT count(*) AS n FROM observability_events').get()).toEqual(before);
  });
  it('returns measured zero for a genuinely empty window', async () => {
    expect(await read(300,400)).toBe(0);
  });
  it('rejects invalid windows so callers retain UNKNOWN rather than a fabricated zero', async () => {
    await expect(read(200,100)).rejects.toThrow('Invalid policy activity window');
    await expect(read(NaN,200)).rejects.toThrow('Invalid policy activity window');
  });
});
