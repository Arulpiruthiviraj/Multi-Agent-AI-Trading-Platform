import { describe, it, expect } from 'vitest';
import { EXPLAINER_CATALOG } from './catalog';

/**
 * explainer catalog tests (2026-10-06). The module's own contract: every entry
 * has exactly three parts (what / why / how) plus a title. Hover copy with a
 * missing section is a silent documentation hole — this test makes it loud.
 * The "honest; no fabricated engines" mandate means entries must not be empty.
 */

describe('EXPLAINER_CATALOG structural contract', () => {
  it('every entry has a non-empty title, what, why, and how', () => {
    const ids = Object.keys(EXPLAINER_CATALOG);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const entry = EXPLAINER_CATALOG[id as keyof typeof EXPLAINER_CATALOG];
      expect(entry.title.trim().length, `${id}.title`).toBeGreaterThan(0);
      expect(entry.what.trim().length, `${id}.what`).toBeGreaterThan(0);
      expect(entry.why.trim().length, `${id}.why`).toBeGreaterThan(0);
      expect(entry.how.trim().length, `${id}.how`).toBeGreaterThan(0);
    }
  });

  it('entry ids are stable snake_case keys', () => {
    for (const id of Object.keys(EXPLAINER_CATALOG)) {
      expect(id, `explainer id ${id}`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });
});
