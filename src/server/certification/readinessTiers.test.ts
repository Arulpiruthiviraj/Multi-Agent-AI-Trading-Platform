import { describe, it, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeTierVerdicts, gatesFor, type TierVerdict } from './readinessTiers';
import { findPackagedJavaJar, probeEngineJson, type ReleaseCheck } from './releaseCertificationDriver';

const c = (field: string, state: ReleaseCheck['state']): ReleaseCheck => ({ field, state, value: null, evidence: '' });
const verdict = (vs: TierVerdict[], tier: string) => vs.find((v) => v.tier === tier)!;

describe('readiness tiers (Oct 13: one global NO-GO mixed four different questions)', () => {
  const safetyPass = [c('BUILD_SHA', 'PASS'), c('RISK_SPINE', 'PASS'), c('OMS', 'PASS'), c('RECONCILIATION', 'PASS'), c('MARKET_DATA_HEALTH', 'PASS'), c('PROTECTIVE_EXIT_RETRY', 'PASS')];

  it('Oct 13 shape: no authorized Quant strategies + unfinished soak + unconfigured Jev wiring => CONTROLLED_PAPER READY, UNATTENDED/QUANT_FIRST NOT_READY, LIVE NO_GO', () => {
    const checks = [...safetyPass,
      c('AUTHORIZED_PAPER_QUANT_STRATEGIES', 'FAIL'), c('FULL_SESSION', 'NOT_RUN'), c('WALL_CLOCK_SOAK', 'NOT_RUN'),
      c('JEV_WIRING', 'NOT_CERTIFIED'), c('JEV_FAILURE_MODE', 'NOT_CERTIFIED'), c('LISTENERS', 'UNKNOWN')];
    const v = computeTierVerdicts(checks);
    expect(verdict(v, 'CONTROLLED_PAPER')).toMatchObject({ status: 'READY', blockingChecks: [] });
    expect(verdict(v, 'UNATTENDED_PAPER')).toMatchObject({ status: 'NOT_READY' });
    expect(verdict(v, 'UNATTENDED_PAPER').blockingChecks).toEqual(expect.arrayContaining(['FULL_SESSION', 'WALL_CLOCK_SOAK', 'LISTENERS']));
    expect(verdict(v, 'UNATTENDED_PAPER').blockingChecks).not.toContain('AUTHORIZED_PAPER_QUANT_STRATEGIES');
    expect(verdict(v, 'QUANT_FIRST').blockingChecks).toContain('AUTHORIZED_PAPER_QUANT_STRATEGIES');
    expect(verdict(v, 'LIVE').status).toBe('NO_GO');
  });

  it('nothing is turned green: any safety check that is not PASS blocks CONTROLLED_PAPER (FAIL, UNKNOWN, NOT_RUN alike)', () => {
    for (const state of ['FAIL', 'UNKNOWN', 'NOT_RUN', 'NOT_CERTIFIED'] as const) {
      const v = computeTierVerdicts([...safetyPass.slice(1), c('RISK_SPINE', state)]);
      expect(verdict(v, 'CONTROLLED_PAPER').status, state).toBe('NOT_READY');
      expect(verdict(v, 'CONTROLLED_PAPER').blockingChecks).toContain('RISK_SPINE');
    }
  });

  it('a check the tier map has never heard of gates EVERY tier (conservative default)', () => {
    expect(gatesFor('SOME_NEW_CHECK')).toEqual(['CONTROLLED_PAPER', 'UNATTENDED_PAPER', 'QUANT_FIRST', 'LIVE']);
    expect(verdict(computeTierVerdicts([...safetyPass, c('SOME_NEW_CHECK', 'UNKNOWN')]), 'CONTROLLED_PAPER').status).toBe('NOT_READY');
  });

  it('LIVE is NO_GO even when every check passes', () => {
    expect(verdict(computeTierVerdicts(safetyPass), 'LIVE').status).toBe('NO_GO');
  });

  it('Jev (advisory AI) never gates a PAPER tier', () => {
    for (const f of ['JEV_CONFIGURED', 'JEV_WIRING', 'JEV_FAILURE_MODE']) {
      expect(gatesFor(f)).toEqual(['LIVE']);
    }
  });
});

describe('certifier portability and authenticated probes', () => {
  it('finds the packaged Java jar with Node fs (the old `ls | head` shell pipeline could never run under Windows cmd.exe)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-jar-'));
    try {
      expect(findPackagedJavaJar(root)).toBeNull();
      fs.mkdirSync(path.join(root, 'quant-core-java', 'target'), { recursive: true });
      fs.writeFileSync(path.join(root, 'quant-core-java', 'target', 'quant-core-java-0.0.1-SNAPSHOT-sources.jar'), 'x');
      fs.writeFileSync(path.join(root, 'quant-core-java', 'target', 'quant-core-java-0.0.1-SNAPSHOT.jar'), 'x');
      expect(findPackagedJavaJar(root)).toBe(path.join(root, 'quant-core-java', 'target', 'quant-core-java-0.0.1-SNAPSHOT.jar'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('live-engine probes send the supplied auth headers: an authenticated engine answers, an unauthenticated probe gets null', async () => {
    const server = http.createServer((req, res) => {
      if (req.headers.cookie !== 'argus_session=good') { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
      res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      expect(await probeEngineJson(base, '/x', 2000)).toBeNull();
      expect(await probeEngineJson(base, '/x', 2000, { Cookie: 'argus_session=good' })).toEqual({ ok: true });
    } finally { server.close(); }
  });
});
