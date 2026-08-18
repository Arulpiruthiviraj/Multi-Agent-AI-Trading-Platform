/**
 * ==========================================================
 * COMPONENT: ContextualTooltip
 *
 * Hover-only explainer (no click / no modal). The bubble is portaled to
 * document.body and positioned with getBoundingClientRect so overflow:hidden
 * cards cannot clip it. Honors tooltipsEnabled: when off, hover is a no-op
 * unless alwaysShow is set (nav tab purpose tooltips).
 * ==========================================================
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { useExplainerSettings } from '../context/ExplainerSettingsContext';
import { EXPLAINER_CATALOG, type ExplainerId } from './explainers/catalog';
import { clampCenteredTooltipLeft } from './responsive/navTabTooltips';

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 80;
const ESTIMATED_TOOLTIP_WIDTH = 352;

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
  /** Hover target is the whole child (e.g. a nav button), not only the label text. */
  wrapTrigger?: boolean;
  /** Show even when educational metric tooltips are toggled off. */
  alwaysShow?: boolean;
  /** Title + primary sentence only (no Why/How blocks). */
  compact?: boolean;
  /** Wrapper class when wrapTrigger is true. */
  className?: string;
  showDelayMs?: number;
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
  wrapTrigger = false,
  alwaysShow = false,
  compact = false,
  className,
  showDelayMs = SHOW_DELAY_MS,
}: ContextualTooltipProps) {
  const { tooltipsEnabled } = useExplainerSettings();
  const enabled = alwaysShow || tooltipsEnabled;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, placeBelow: false });
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  const entry = explainerId ? EXPLAINER_CATALOG[explainerId] : null;
  const resolvedTitle = entry?.title ?? title ?? '';
  const resolvedWhat = entry?.what ?? what ?? content ?? '';
  const resolvedWhy = compact ? '' : (entry?.why ?? why ?? '');
  const resolvedHow = compact ? '' : (entry?.how ?? how ?? '');
  const icon = showIcon ?? !children;
  const hasBody = Boolean(resolvedWhat || resolvedWhy || resolvedHow);

  const clearTimers = () => {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  const measure = (tooltipWidth = ESTIMATED_TOOLTIP_WIDTH) => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const placeBelow = r.top < 160 || r.bottom + 120 < window.innerHeight;
    const left = clampCenteredTooltipLeft(
      r.left + r.width / 2,
      tooltipWidth,
      window.innerWidth,
    );
    const top = placeBelow ? r.bottom + 8 : r.top - 8;
    setCoords((prev) => (
      prev.top === top && prev.left === left && prev.placeBelow === placeBelow
        ? prev
        : { top, left, placeBelow }
    ));
  };

  const hideNow = () => {
    clearTimers();
    setOpen(false);
  };

  const onEnter = () => {
    if (!enabled || !hasBody) return;
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    showTimer.current = window.setTimeout(() => {
      measure();
      setOpen(true);
    }, showDelayMs);
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
    const onMove = () => measure(bubbleRef.current?.offsetWidth ?? ESTIMATED_TOOLTIP_WIDTH);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !bubbleRef.current) return;
    measure(bubbleRef.current.offsetWidth);
  }, [open, resolvedWhat, resolvedTitle]);

  const bubble = open && enabled && hasBody && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={bubbleRef}
          id={tooltipId}
          role="tooltip"
          className={`pointer-events-none fixed z-[400] max-w-[22rem] -translate-x-1/2 rounded-lg border border-slate-600 bg-[#0b1220] px-3 py-2 text-left shadow-[0_12px_40px_rgba(0,0,0,0.55)] ${
            coords.placeBelow ? '' : '-translate-y-full'
          }`}
          style={{ top: coords.top, left: coords.left }}
        >
          <div
            className="argus-tooltip-in"
            data-place={coords.placeBelow ? 'below' : 'above'}
          >
            {resolvedTitle && (
              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-300/90">
                {resolvedTitle}
              </div>
            )}
            {resolvedWhat && (
              <p className="text-[12px] leading-relaxed text-slate-100">{resolvedWhat}</p>
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
          </div>
        </div>,
        document.body,
      )
    : null;

  const triggerClass = wrapTrigger
    ? (className ?? 'inline-flex max-w-full align-middle')
    : 'inline-flex items-center max-w-full align-middle';

  return (
    <>
      <span
        ref={triggerRef}
        className={triggerClass}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocusCapture={onEnter}
        onBlurCapture={onLeave}
        onPointerDown={hideNow}
        aria-describedby={open && enabled && hasBody ? tooltipId : undefined}
      >
        {children && !icon ? (
          wrapTrigger ? children : (
            <span
              className={enabled ? (quiet ? 'cursor-help' : 'cursor-help border-b border-dotted border-slate-500/80') : undefined}
            >
              {children}
            </span>
          )
        ) : (
          children
        )}
        {icon && (
          <span className="ml-1 inline-flex">
            <span
              className={`inline-flex text-slate-500 ${enabled ? 'cursor-help hover:text-indigo-400' : 'cursor-default opacity-50'}`}
              aria-label={enabled ? `Explain ${resolvedTitle || 'this metric'}` : undefined}
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
