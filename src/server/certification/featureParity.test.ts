import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyFeatureParity } from './featureParity';
import { getJevShadowStatus } from '../news/JevNewsTriage';

const base = { implemented: true, enabled: true, intendedActive: true, eventsInvoked: null, resultsPersisted: null };

describe('classifyFeatureParity', () => {
  it('a configured-but-disabled feature is DISABLED_BY_CONFIGURATION, never integrated', () => {
    const v = classifyFeatureParity({ ...base, enabled: false, intendedActive: false, blockedReason: 'flag off' });
    expect(v.status).toBe('DISABLED_BY_CONFIGURATION'); expect(v.verdict).toBe('PASS'); expect(v.reason).toContain('flag off');
  });
  it('a feature the release intends to be active but the configuration blocks FAILS', () => {
    const v = classifyFeatureParity({ ...base, enabled: false, blockedReason: "ARGUS_JEV_SHADOW_SCORING_ENABLED is not 'true'" });
    expect(v.status).toBe('ENABLED_BUT_BLOCKED'); expect(v.verdict).toBe('FAIL');
  });
  it('enabled as intended but unobservable pre-deployment is NOT_PROVEN, never PASS', () => {
    expect(classifyFeatureParity(base)).toMatchObject({ status: 'ENABLED_NOT_YET_OBSERVED', verdict: 'NOT_PROVEN' });
    expect(classifyFeatureParity({ ...base, eventsInvoked: 0, resultsPersisted: 0 })).toMatchObject({ verdict: 'NOT_PROVEN' });
  });
  it('invoked but not persisting FAILS; invoked and persisting passes', () => {
    expect(classifyFeatureParity({ ...base, eventsInvoked: 5, resultsPersisted: 0 })).toMatchObject({ status: 'INVOKED_NOT_PERSISTING', verdict: 'FAIL' });
    expect(classifyFeatureParity({ ...base, eventsInvoked: 5, resultsPersisted: 5 })).toMatchObject({ status: 'ACTIVE', verdict: 'PASS' });
  });
  it('enabled while the release intends it off FAILS (unintended activation)', () => {
    expect(classifyFeatureParity({ ...base, intendedActive: false })).toMatchObject({ verdict: 'FAIL' });
  });
});

describe('Jev parity against the effective environment (the 2026-10-15 production state)', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.JEV_API_KEY = 'k'; delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED; });
  afterEach(() => { process.env = { ...saved }; });
  it('key present + shadow flag unset is reported as blocked, so "configured" cannot be read as "working"', () => {
    const s = getJevShadowStatus();
    expect(s.keyConfigured).toBe(true);
    const v = classifyFeatureParity({ implemented: true, enabled: s.active, blockedReason: s.idleReason, intendedActive: true, eventsInvoked: null, resultsPersisted: null });
    expect(v).toMatchObject({ status: 'ENABLED_BUT_BLOCKED', verdict: 'FAIL' });
    expect(v.reason).toContain('ARGUS_JEV_SHADOW_SCORING_ENABLED');
  });
  it('with the flag set the same release configuration is enabled but still NOT_PROVEN until real events are observed', () => {
    process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
    const s = getJevShadowStatus();
    const v = classifyFeatureParity({ implemented: true, enabled: s.active, blockedReason: s.idleReason, intendedActive: true, eventsInvoked: null, resultsPersisted: null });
    expect(v).toMatchObject({ status: 'ENABLED_NOT_YET_OBSERVED', verdict: 'NOT_PROVEN' });
  });
});
