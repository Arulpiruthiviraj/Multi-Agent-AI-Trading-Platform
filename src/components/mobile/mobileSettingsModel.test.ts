import { describe, expect, it } from 'vitest';
import {
  formatBool,
  formatEnvFallback,
  isTruthyEffective,
  matchesSearch,
  optimisticBoolOverride,
  optimisticResetToEnv,
  RUNTIME_KEYS,
  sourceBadge,
  type EffectiveRow,
} from './mobileSettingsModel';

function row(partial: Partial<EffectiveRow>): EffectiveRow {
  return {
    setting: RUNTIME_KEYS.opportunity,
    label: 'Opportunity scanner',
    category: 'OPPORTUNITY',
    type: 'boolean',
    description: 'Continuous discovery overlay',
    effectiveValue: false,
    envValue: 'false',
    dbOverride: null,
    source: 'ENV',
    overridable: true,
    safetyLocked: false,
    secret: false,
    applyMode: 'immediate',
    restartRequired: false,
    ...partial,
  };
}

describe('mobileSettingsModel', () => {
  it('formats boolean effective values as ON/OFF', () => {
    expect(formatBool(true)).toBe('ON');
    expect(formatBool('true')).toBe('ON');
    expect(formatBool(false)).toBe('OFF');
    expect(formatBool('false')).toBe('OFF');
    expect(formatBool(null)).toBe('—');
  });

  it('labels provenance sources for the mobile badges', () => {
    expect(sourceBadge('SETTINGS').label).toBe('DB Override');
    expect(sourceBadge('ENV').label).toBe('.env Default');
    expect(sourceBadge('DEFAULT').label).toBe('Safe default');
  });

  it('shows .env fallback without exposing secrets', () => {
    expect(formatEnvFallback(row({ envValue: 'false' }))).toBe('(.env: OFF)');
    expect(formatEnvFallback(row({ envValue: 'true' }))).toBe('(.env: ON)');
    expect(formatEnvFallback(row({ envValue: null }))).toBe('(.env: unset)');
    expect(formatEnvFallback(row({ secret: true, configured: true }))).toBe('(.env: Configured)');
    expect(formatEnvFallback(row({ secret: true, configured: false }))).toBe('(.env: Missing)');
  });

  it('matches search across key, label, description, and category', () => {
    const sample = row({});
    expect(matchesSearch(sample, '')).toBe(true);
    expect(matchesSearch(sample, 'opportunity')).toBe(true);
    expect(matchesSearch(sample, 'ARGUS_OPPORTUNITY_LOOP_ENABLED')).toBe(true);
    expect(matchesSearch(sample, 'xyz-no-match')).toBe(false);
  });

  it('optimistic toggle marks a DB overlay and reset returns to .env', () => {
    const envOff = row({ effectiveValue: false, envValue: 'false', source: 'ENV' });
    const overlay = optimisticBoolOverride(envOff, true);
    expect(overlay.source).toBe('SETTINGS');
    expect(overlay.effectiveValue).toBe(true);
    expect(isTruthyEffective(overlay)).toBe(true);
    const reverted = optimisticResetToEnv(overlay);
    expect(reverted.source).toBe('ENV');
    expect(reverted.dbOverride).toBeNull();
    expect(isTruthyEffective(reverted)).toBe(false);
  });
});
