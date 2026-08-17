/**
 * ==========================================================
 * Module: UnavailableHint
 *
 * Native-title hover for honest empty metrics (`--`, N/A, DATA UNAVAILABLE).
 * Always-on (not gated by the educational explainer toggle) so operators can
 * see *why* a field is empty and *when* it becomes a real number.
 * ==========================================================
 */
import React from 'react';

export function UnavailableHint({
  reason,
  children = '--',
  className,
}: {
  reason: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`cursor-help border-b border-dotted border-slate-600/80 ${className ?? ''}`}
      title={reason}
    >
      {children}
    </span>
  );
}
