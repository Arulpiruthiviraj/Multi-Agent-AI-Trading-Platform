/** Evidence aggregation only. It cannot attest an artifact or execute a certification. */
export type ReleaseEvidenceStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_APPLICABLE' | 'NOT_CERTIFIED' | 'UNKNOWN';
export interface ReleaseEvidenceCheck { area: string; status: ReleaseEvidenceStatus }
const statuses = new Set<ReleaseEvidenceStatus>(['PASS', 'FAIL', 'NOT_RUN', 'NOT_APPLICABLE', 'NOT_CERTIFIED', 'UNKNOWN']);

/** Required gates accept explicit PASS only, including gates claimed not applicable.
 * Missing, duplicate and malformed observations remain unknown rather than green.
 * Observations must come from executed checks; caller-supplied manifests are not attestation.
 */
export function summarizeReleaseEvidence(required: string[], observations: ReleaseEvidenceCheck[]) {
  if (!required.length || required.some(area => typeof area !== 'string' || !area.trim())
      || new Set(required).size !== required.length) throw new Error('INVALID_RELEASE_CERTIFICATION_CONFIG');
  const checks = required.map(area => {
    const matches = observations.filter(check => check.area === area);
    const status: ReleaseEvidenceStatus = matches.length === 0 ? 'NOT_RUN'
      : matches.length !== 1 || !statuses.has(matches[0].status) ? 'UNKNOWN' : matches[0].status;
    return { area, status };
  });
  return { checks, allRequiredPassed: checks.every(check => check.status === 'PASS'),
    blockers: checks.filter(check => check.status !== 'PASS') };
}
