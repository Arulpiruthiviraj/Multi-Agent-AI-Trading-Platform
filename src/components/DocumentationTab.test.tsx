// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import DocumentationTab from './DocumentationTab';

/**
 * DocumentationTab tests (2026-10-06). Verifies the browser-visible Documentation
 * renders and that the Jev environment-variable section (added 2026-10-06) is
 * present with accurate copy. Uses the real component with mocked tab navigation.
 */

describe('DocumentationTab', () => {
  it('renders without crashing', () => {
    const setActiveTab = vi.fn();
    const { container } = render(<DocumentationTab setActiveTab={setActiveTab} />);
    expect(container.textContent!.length).toBeGreaterThan(100);
    cleanup();
  });

  it('includes the Jev environment-variable section added 2026-10-06', async () => {
    const setActiveTab = vi.fn();
    const { container } = render(<DocumentationTab setActiveTab={setActiveTab} />);
    // The env vars live in the "Live Trading & Environment Configuration" section; navigate there first.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Live Trading & Environment Configuration'));
    const text = container.textContent ?? '';
    // The Jev flags must be documented where operators look for env vars.
    expect(text).toContain('JEV_API_KEY');
    expect(text).toContain('ARGUS_JEV_SHADOW_SCORING_ENABLED');
    expect(text).toContain('ARGUS_JEV_ESCALATION_ENABLED');
    // The copy must honestly state Jev never influences trading decisions.
    expect(text).toContain('Jev never influences a trading decision');
    cleanup();
  });

  it('documents that both Jev flags default off', async () => {
    const setActiveTab = vi.fn();
    const { container } = render(<DocumentationTab setActiveTab={setActiveTab} />);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByText('Live Trading & Environment Configuration'));
    expect(container.textContent).toContain('Both flags default off');
    cleanup();
  });
});
