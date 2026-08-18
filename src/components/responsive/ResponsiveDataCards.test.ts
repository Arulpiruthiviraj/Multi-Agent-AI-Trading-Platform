import { describe, it, expect } from 'vitest';
import { partitionColumns } from './ResponsiveDataCards';

describe('partitionColumns', () => {
  const columns = [
    { key: 'a', header: 'A', primary: true, render: () => null },
    { key: 'b', header: 'B', primary: true, render: () => null },
    { key: 'c', header: 'C', render: () => null },
    { key: 'd', header: 'D', render: () => null },
  ];

  it('splits primary vs secondary when primary flagged', () => {
    const { primary, secondary } = partitionColumns(columns);
    expect(primary.map((c) => c.key)).toEqual(['a', 'b']);
    expect(secondary.map((c) => c.key)).toEqual(['c', 'd']);
  });

  it('defaults to first two primary when none flagged', () => {
    const plain = columns.map(({ primary: _p, ...rest }) => rest);
    const { primary, secondary } = partitionColumns(plain);
    expect(primary.map((c) => c.key)).toEqual(['a', 'b']);
    expect(secondary.map((c) => c.key)).toEqual(['c', 'd']);
  });
});
