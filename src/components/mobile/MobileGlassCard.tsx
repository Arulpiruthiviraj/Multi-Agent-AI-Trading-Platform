import React from 'react';

interface MobileGlassCardProps {
  children: React.ReactNode;
  className?: string;
  glow?: 'emerald' | 'crimson' | 'cyan' | 'none';
  active?: boolean;
  onClick?: () => void;
}

export function MobileGlassCard({
  children,
  className = '',
  glow = 'none',
  active = false,
  onClick,
}: MobileGlassCardProps) {
  const glowClass = glow === 'emerald' ? 'mobile-glow-emerald'
    : glow === 'crimson' ? 'mobile-glow-crimson'
      : glow === 'cyan' ? 'mobile-glow-cyan' : '';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`mobile-glass mobile-press p-4 ${active ? 'mobile-glass-active' : ''} ${glowClass} ${className} ${onClick ? 'text-left w-full' : ''}`}
    >
      {children}
    </Tag>
  );
}
