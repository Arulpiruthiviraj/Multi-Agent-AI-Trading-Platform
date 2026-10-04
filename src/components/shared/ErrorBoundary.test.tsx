// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ErrorBoundary, PanelBoundary } from './ErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('boom: test crash');
  return <div data-testid="healthy-child">healthy</div>;
}

describe('ErrorBoundary', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs caught errors via console.error — silence for clean test output.
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleSpy.mockRestore();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary label="Test panel">
        <div data-testid="healthy-child">healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });

  it('catches a child render crash and shows a labelled fallback', () => {
    render(
      <ErrorBoundary label="Strategy scanner">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();
    expect(screen.getByText('Strategy scanner crashed')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    // Recovery affordance exists.
    expect(screen.getByText(/Reload Strategy scanner/)).toBeTruthy();
  });

  it('recovers via the reload button without a page refresh', () => {
    const { rerender } = render(
      <ErrorBoundary label="Test panel">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();

    rerender(
      <ErrorBoundary label="Test panel">
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText(/Reload Test panel/));
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });

  it('auto-resets when resetKeys change (e.g. tab switch)', () => {
    const { rerender } = render(
      <ErrorBoundary label="Test panel" resetKeys={['tab-a']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();

    // Same crash, but the user navigated elsewhere and back: boundary resets.
    rerender(
      <ErrorBoundary label="Test panel" resetKeys={['tab-b']}>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
  });

  it('honours a custom fallback renderer', () => {
    render(
      <ErrorBoundary
        label="Test panel"
        fallback={(err, reset) => (
          <div data-testid="custom-fallback">
            custom: {err.message} <button onClick={reset}>retry</button>
          </div>
        )}
      >
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom-fallback').textContent).toContain('boom: test crash');
  });

  it('forwards caught errors to onError', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary label="Test panel" onError={onError}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('PanelBoundary renders the labelled boundary', () => {
    render(
      <PanelBoundary label="Arena">
        <Bomb shouldThrow />
      </PanelBoundary>,
    );
    expect(screen.getByText('Arena crashed')).toBeTruthy();
  });
});
