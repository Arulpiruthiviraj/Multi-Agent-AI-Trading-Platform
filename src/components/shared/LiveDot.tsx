import { motion } from 'motion/react';

/**
 * LiveDot — status dot with a sonar ping for the live state.
 *
 * Replaces static colored dots on connection/broker/feed health badges so
 * "live" reads as live at a glance.
 */
export function LiveDot({
  status = 'live',
  size = 8,
}: {
  status?: 'live' | 'degraded' | 'down' | 'idle';
  size?: number;
}) {
  const color =
    status === 'live'
      ? '#34d399'
      : status === 'degraded'
        ? '#fbbf24'
        : status === 'down'
          ? '#fb7185'
          : '#64748b';
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {status === 'live' && (
        <motion.span
          className="absolute inline-flex h-full w-full rounded-full"
          style={{ backgroundColor: color }}
          animate={{ scale: [1, 2.4], opacity: [0.7, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <span
        className="relative inline-flex rounded-full"
        style={{ width: size, height: size, backgroundColor: color }}
      />
    </span>
  );
}
