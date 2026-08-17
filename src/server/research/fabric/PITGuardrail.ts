/**
 * Reject research metrics that were not public as of the decision bar (look-ahead guard).
 * Research-only. Does not touch live trading.
 */
import type { PitValidationResult, ResearchPacket } from './types';

export function validatePointInTime(
  packet: ResearchPacket,
  currentBarTimestamp: number,
): PitValidationResult {
  const rejected: PitValidationResult['rejectedMetrics'] = [];
  let accepted = 0;
  for (const m of packet.metrics) {
    if (!Number.isFinite(m.publicReleaseDate)) {
      rejected.push({
        key: m.key,
        reason: 'MISSING_PUBLIC_RELEASE_DATE',
        publicReleaseDate: Number.NaN,
        currentBarTimestamp,
      });
      continue;
    }
    if (m.publicReleaseDate > currentBarTimestamp) {
      rejected.push({
        key: m.key,
        reason: 'LOOKAHEAD_PUBLIC_RELEASE_AFTER_BAR',
        publicReleaseDate: m.publicReleaseDate,
        currentBarTimestamp,
      });
      continue;
    }
    if (m.asOfTimestamp != null && m.asOfTimestamp > currentBarTimestamp) {
      rejected.push({
        key: m.key,
        reason: 'LOOKAHEAD_ASOF_AFTER_BAR',
        publicReleaseDate: m.publicReleaseDate,
        currentBarTimestamp,
      });
      continue;
    }
    accepted += 1;
  }
  return {
    ok: rejected.length === 0,
    rejectedMetrics: rejected,
    acceptedMetricCount: accepted,
  };
}

export function filterPacketToPointInTime(
  packet: ResearchPacket,
  currentBarTimestamp: number,
): ResearchPacket {
  const v = validatePointInTime(packet, currentBarTimestamp);
  if (v.ok) return packet;
  const rejectedKeys = new Set(v.rejectedMetrics.map((r) => r.key));
  return {
    ...packet,
    metrics: packet.metrics.filter((m) => !rejectedKeys.has(m.key)),
  };
}
