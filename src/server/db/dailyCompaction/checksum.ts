import { createHash } from 'crypto';

/** Deterministic canonical-JSON stringify (sorted object keys) so the checksum is stable
 *  regardless of key insertion order - JSON.stringify alone is not. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function computeChecksum(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}
