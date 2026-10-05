import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * Reveal — fade-up entrance on mount with an optional stagger delay.
 *
 * Wrap dashboard cards / panel sections so the workspace assembles itself
 * instead of popping in. Delay is in seconds; pass i * 0.06 for stagger.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  y = 14,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  y?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
