import { useEffect } from 'react';

/**
 * useEscapeKey — call `onClose` when the user presses Escape.
 *
 * Industry-standard modal hygiene: every dismissible overlay should close on
 * Escape. Pass a stable callback; the hook no-ops when `onClose` is null or
 * `enabled` is false.
 */
export function useEscapeKey(onClose: (() => void) | null | undefined, enabled = true): void {
  useEffect(() => {
    if (!enabled || !onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, enabled]);
}
