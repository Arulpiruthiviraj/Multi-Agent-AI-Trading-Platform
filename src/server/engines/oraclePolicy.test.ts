import { describe, it, expect } from 'vitest';
import { ORACLE_SECTORS, sectorOf } from '../../../scripts/sim/oraclePolicy';
import { SECTOR_MAP, getSector } from './PositionSizing';

describe('oracle sector policy copy equals the production sector policy', () => {
  it('every production symbol with a sector cap maps identically, and ETFs have none', () => {
    for (const sym of Object.keys(SECTOR_MAP)) expect(sectorOf(sym), sym).toBe(getSector(sym));
    for (const sym of Object.keys(ORACLE_SECTORS)) expect(SECTOR_MAP[sym], sym).toBe(ORACLE_SECTORS[sym]);
  });
});
