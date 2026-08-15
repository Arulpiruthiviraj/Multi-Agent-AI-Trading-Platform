import { describe, it, expect } from 'vitest';
import { parseResearchNote, isBullBearResearchEnabled, bullBearResearchConfig } from './parseResearchNote';

describe('parseResearchNote', () => {
  it('is disabled unless the configured env var is true', () => {
    delete process.env[bullBearResearchConfig.enabledEnvVar];
    expect(isBullBearResearchEnabled()).toBe(false);
  });

  it('rejects LLM-invented numeric market fields and keeps them null', () => {
    const note = parseResearchNote({
      stance: 'bear',
      thesisSummary: 'Extended from VWAP',
      supportingFactors: ['RVOL fade'],
      entry: 210.25,
      stop: 207.8,
      target: 200,
      expectedValue: 0.02,
      probability: 0.81,
    }, 'BEAR');
    expect(note.entry).toBeNull();
    expect(note.stop).toBeNull();
    expect(note.target).toBeNull();
    expect(note.expectedValue).toBeNull();
    expect(note.probability).toBeNull();
    expect(note.inventedNumericFieldsRejected).toEqual(
      expect.arrayContaining(bullBearResearchConfig.numericFieldsMustComeFromQuant),
    );
    expect(note.thesisSummary).toBe('Extended from VWAP');
  });
});
