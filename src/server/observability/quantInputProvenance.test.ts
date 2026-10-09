import { describe, expect, it, vi, afterEach } from 'vitest';
import { encodeQuantInputEvidence, decodeQuantInputEvidence, recordQuantInputEvidence } from './quantInputProvenance';
import { observabilityConfig } from '../config/observability';
import { structuredLogger } from './StructuredLogger';

afterEach(() => vi.restoreAllMocks());
describe('bounded diagnostic context evidence (no trading authority)', () => {
  it('round trips the actual context, bars, nulls and unicode without mutating inputs', () => {
    const input = { strategyContext: { symbol: 'SNOW', currentPrice: 355.49, note: 'π ❄', unavailable: null }, bars: [{ timestamp: 1, close: 354 }] };
    const before = structuredClone(input);
    const capture = encodeQuantInputEvidence(input, observabilityConfig.quantInputEvidenceMaxBytes, 17);
    expect(capture.chunks.length).toBeGreaterThan(1);
    expect(decodeQuantInputEvidence(capture.chunks, capture.chunks.length, capture.sha256!)).toEqual(input);
    expect(input).toEqual(before);
  });
  it('never certifies partial, reordered or altered chunks', () => {
    const capture = encodeQuantInputEvidence({ price: 123, symbol: 'MRNA' }, 1000, 7);
    expect(() => decodeQuantInputEvidence(capture.chunks.slice(1), capture.chunks.length, capture.sha256!)).toThrow('Incomplete');
    expect(() => decodeQuantInputEvidence([...capture.chunks].reverse(), capture.chunks.length, capture.sha256!)).toThrow('digest');
    expect(() => decodeQuantInputEvidence(capture.chunks, capture.chunks.length, 'bad')).toThrow('digest');
  });
  it('redacts secrets before encoding so base64 cannot hide them from redaction', () => {
    const capture = encodeQuantInputEvidence({ symbol: 'CRCL', password: 'DO_NOT_PERSIST', headers: { Authorization: 'Bearer DO_NOT_PERSIST' } }, 1000, 100);
    expect(Buffer.concat(capture.chunks.map(c => Buffer.from(c, 'base64'))).toString()).not.toContain('DO_NOT_PERSIST');
  });
  it('reports a size refusal instead of a truncated replayable context', () => {
    const capture = encodeQuantInputEvidence({ value: 'x'.repeat(100) }, 10, 5);
    expect(capture).toMatchObject({ status: 'SIZE_LIMIT', chunks: [], sha256: null });
  });
  it('rejects invalid bounds', () => {
    expect(() => encodeQuantInputEvidence({}, 100, 0)).toThrow('bounds');
  });
  it('performs no serialization or logging while the feature is disabled', () => {
    expect(observabilityConfig.quantInputEvidenceEnabled).toBe(false);
    const log = vi.spyOn(structuredLogger, 'info');
    recordQuantInputEvidence('SNOW', 'trace', { get value() { throw new Error('must not read'); } });
    const factory = vi.fn(() => { throw new Error('must not observe quotes'); });
    recordQuantInputEvidence('SNOW', 'trace', factory);
    expect(factory).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it('cannot interrupt the caller when enabled capture or logging fails', () => {
    const enabled = observabilityConfig.quantInputEvidenceEnabled;
    observabilityConfig.quantInputEvidenceEnabled = true;
    try {
      expect(() => recordQuantInputEvidence('SNOW', 'trace', () => { throw new Error('diagnostic unavailable'); })).not.toThrow();
      vi.spyOn(structuredLogger, 'info').mockImplementation(() => { throw new Error('logger unavailable'); });
      expect(() => recordQuantInputEvidence('SNOW', 'trace', { price: 355 })).not.toThrow();
    } finally { observabilityConfig.quantInputEvidenceEnabled = enabled; }
  });
  it('emits a manifest and reconstructable bounded chunks when explicitly enabled', () => {
    const enabled = observabilityConfig.quantInputEvidenceEnabled;
    observabilityConfig.quantInputEvidenceEnabled = true;
    try {
      const log = vi.spyOn(structuredLogger, 'info').mockImplementation(() => {});
      const input = { strategyContext: { currentPrice: 355.49 }, bars: [{ timestamp: 1, close: 354 }] };
      const factory = vi.fn(() => input);
      recordQuantInputEvidence('SNOW', 'trace-snow', factory);
      expect(factory).toHaveBeenCalledTimes(1);
      const manifest = log.mock.calls.find(([message]) => message === 'quant_input_evidence_manifest')![1]!;
      expect(manifest).toMatchObject({ status: 'CAPTURED', replayScope: 'CONTEXT_REPLAY_ONLY', traceId: 'trace-snow' });
      const chunks = log.mock.calls.filter(([message]) => message === 'quant_input_evidence_chunk').map(([, fields]) => fields!.data as string);
      expect(decodeQuantInputEvidence(chunks, manifest.chunkCount as number, manifest.sha256 as string)).toEqual(input);
    } finally { observabilityConfig.quantInputEvidenceEnabled = enabled; }
  });
  it('keeps each configured chunk envelope below the logger payload cap', () => {
    const capture = encodeQuantInputEvidence({ value: 'x'.repeat(20000) }, observabilityConfig.quantInputEvidenceMaxBytes, observabilityConfig.quantInputEvidenceChunkBytes);
    for (const data of capture.chunks) expect(JSON.stringify({ data, chunkIndex: 1, chunkCount: 100, sha256: capture.sha256 }).length).toBeLessThan(observabilityConfig.maxPayloadChars);
  });
});

