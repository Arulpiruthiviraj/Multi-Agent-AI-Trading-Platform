/** Diagnostic serialization only: never computes a signal or grants trading authority. */
import { createHash } from 'node:crypto';
import { observabilityConfig } from '../config/observability';
import { redactSecretsDeep } from '../core/SecretRedaction';
import { structuredLogger, observeSafe } from './StructuredLogger';

export function encodeQuantInputEvidence(input: unknown, maxBytes: number, chunkBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error('Invalid quant input evidence bounds');
  }
  const bytes = Buffer.from(JSON.stringify(redactSecretsDeep(input)), 'utf8');
  if (bytes.length > maxBytes) return { status: 'SIZE_LIMIT' as const, byteLength: bytes.length, chunks: [] as string[], sha256: null };
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) chunks.push(bytes.subarray(offset, offset + chunkBytes).toString('base64'));
  return { status: 'CAPTURED' as const, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunks };
}

/** Missing/dropped chunks or a digest mismatch are incomplete evidence, never replayable input. */
export function decodeQuantInputEvidence(chunks: readonly string[], expectedCount: number, sha256: string): unknown {
  if (chunks.length !== expectedCount || expectedCount <= 0) throw new Error('Incomplete quant input evidence');
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Quant input evidence digest mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

export function recordQuantInputEvidence(symbol: string, traceId: string, input: unknown): void {
  if (!observabilityConfig.quantInputEvidenceEnabled) return;
  observeSafe(() => {
    const evidence = encodeQuantInputEvidence(typeof input === 'function' ? input() : input, observabilityConfig.quantInputEvidenceMaxBytes, observabilityConfig.quantInputEvidenceChunkBytes);
    structuredLogger.info('quant_input_evidence_manifest', {
      category: 'DISCOVERY', eventType: 'QUANT_INPUT_EVIDENCE_MANIFEST', symbol, traceId,
      schemaVersion: 1, status: evidence.status, byteLength: evidence.byteLength,
      chunkCount: evidence.chunks.length, sha256: evidence.sha256, encoding: 'BASE64_UTF8_JSON',
      replayScope: 'CONTEXT_REPLAY_ONLY',
    });
    evidence.chunks.forEach((data, chunkIndex) => structuredLogger.info('quant_input_evidence_chunk', {
      category: 'DISCOVERY', eventType: 'QUANT_INPUT_EVIDENCE_CHUNK', symbol, traceId,
      chunkIndex, chunkCount: evidence.chunks.length, sha256: evidence.sha256, data,
    }));
  }, 'QUANT_INPUT_EVIDENCE');
}
