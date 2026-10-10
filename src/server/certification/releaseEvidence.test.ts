// LABEL: UNIT
import { describe, expect, it } from 'vitest';
import { summarizeReleaseEvidence, type ReleaseEvidenceStatus } from './releaseEvidence';
import releaseConfig from '../../../config/releaseCertification.json';

describe('required release evidence semantics', () => {
  const required = releaseConfig.requiredEvidence;
  const passing = () => required.map(area => ({ area, status: 'PASS' as const }));
  it.each(['FAIL', 'NOT_RUN', 'NOT_APPLICABLE', 'NOT_CERTIFIED', 'UNKNOWN'] as ReleaseEvidenceStatus[])(
    '%s cannot satisfy a required gate', status => {
      const observed = passing().map((check, index) => index === 0 ? { ...check, status } : check);
      expect(summarizeReleaseEvidence(required, observed).allRequiredPassed).toBe(false);
    });
  it('all explicit PASS satisfies aggregation, without claiming artifact attestation', () => {
    expect(summarizeReleaseEvidence(required, passing()).allRequiredPassed).toBe(true);
  });
  it('missing, duplicate and unsupported states fail closed', () => {
    expect(summarizeReleaseEvidence(required, []).checks.every(check => check.status === 'NOT_RUN')).toBe(true);
    expect(summarizeReleaseEvidence(required, [...passing(), passing()[0]]).checks[0].status).toBe('UNKNOWN');
    expect(summarizeReleaseEvidence(required, [{ area: required[0], status: 'PARTIAL' as ReleaseEvidenceStatus }]).checks[0].status).toBe('UNKNOWN');
  });
  it('invalid required inventory cannot produce vacuous PASS', () => {
    for (const bad of [[], [''], ['gate', 'gate']]) expect(() => summarizeReleaseEvidence(bad, [])).toThrow();
  });
});
