/**
 * ==========================================================
 * COMPONENT: ContextualTooltip
 *
 * Hover-only explainer (no click / no modal). The bubble is portaled to
 * document.body and positioned with getBoundingClientRect so overflow:hidden
 * cards cannot clip it. Honors tooltipsEnabled: when off, hover is a no-op.
 * ==========================================================
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { useExplainerSettings } from '../context/ExplainerSettingsContext';
import { EXPLAINER_CATALOG, type ExplainerId } from './explainers/catalog';

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 80;

interface ContextualTooltipProps {
  title?: string;
  content?: string;
  what?: string;
  why?: string;
  how?: string;
  explainerId?: ExplainerId;
  children?: ReactNode;
  showIcon?: boolean;
  /** No dotted underline — for tabs, badges, and status chips. */
  quiet?: boolean;
}

export function ContextualTooltip({
  title,
  content,
  what,
  why,
  how,
  explainerId,
  children,
  showIcon,
  quiet = false,
}: ContextualTooltipProps) {
  const { tooltipsEnabled } = useExplainerSettings();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, placeBelow: false });
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  const entry = explainerId ? EXPLAINER_CATALOG[explainerId] : null;
  const resolvedTitle = entry?.title ?? title ?? '';
  const resolvedWhat = entry?.what ?? what ?? content ?? '';
  const resolvedWhy = entry?.why ?? why ?? '';
  const resolvedHow = entry?.how ?? how ?? '';
  const icon = showIcon ?? !children;
  const hasBody = Boolean(resolvedWhat || resolvedWhy || resolvedHow);

  const clearTimers = () => {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const placeBelow = r.top < 140;
    setCoords({
      top: placeBelow ? r.bottom + 8 : r.top - 8,
      left: r.left + r.width / 2,
      placeBelow,
    });
  };

  const onEnter = () => {
    if (!tooltipsEnabled || !hasBody) return;
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    showTimer.current = window.setTimeout(() => {
      measure();
      setOpen(true);
    }, SHOW_DELAY_MS);
  };

  const onLeave = () => {
    if (showTimer.current) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    hideTimer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  };

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const bubble = open && tooltipsEnabled && hasBody && typeof document !== 'undefined'
    ? createPortal(
        <div
          role="tooltip"
          className={`pointer-events-none fixed z-[200] max-w-xs -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-left shadow-xl ${
            coords.placeBelow ? '' : '-translate-y-full'
          }`}
          style={{ top: coords.top, left: coords.left }}
        >
          {resolvedTitle && (
            <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-slate-100">
              {resolvedTitle}
            </div>
          )}
          {resolvedWhat && (
            <p className="text-[12px] leading-relaxed text-slate-200">{resolvedWhat}</p>
          )}
          {resolvedWhy && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">
              <span className="font-semibold text-amber-400/90">Why: </span>
              {resolvedWhy}
            </p>
          )}
          {resolvedHow && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-300">
              <span className="font-semibold text-emerald-400/90">How: </span>
              {resolvedHow}
            </p>
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span className="inline-flex items-center max-w-full align-middle">
        {children && !icon ? (
          <span
            ref={triggerRef}
            className={tooltipsEnabled ? (quiet ? 'cursor-help' : 'cursor-help border-b border-dotted border-slate-500/80') : undefined}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
          >
            {children}
          </span>
        ) : (
          children
        )}
        {icon && (
          <span
            ref={triggerRef}
            className="ml-1 inline-flex"
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
          >
            <span
              className={`inline-flex text-slate-500 ${tooltipsEnabled ? 'cursor-help hover:text-indigo-400' : 'cursor-default opacity-50'}`}
              aria-label={tooltipsEnabled ? `Explain ${resolvedTitle || 'this metric'}` : undefined}
            >
              <HelpCircle size={13} />
            </span>
          </span>
        )}
      </span>
      {bubble}
    </>
  );
}

export function Explainer({
  id,
  children,
  className,
  quiet = false,
}: {
  id: ExplainerId;
  children: ReactNode;
  className?: string;
  quiet?: boolean;
}) {
  return (
    <ContextualTooltip explainerId={id} showIcon={false} quiet={quiet}>
      <span className={className}>{children}</span>
    </ContextualTooltip>
  );
}
