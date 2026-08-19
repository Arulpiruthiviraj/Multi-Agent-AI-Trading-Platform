import type { LucideIcon } from 'lucide-react';
import { Brain, LayoutDashboard, Settings, Shield, Terminal, Wallet } from 'lucide-react';

export type MobileTabId = 'cockpit' | 'positions' | 'brain' | 'risk' | 'terminal' | 'settings';

export interface MobileTabDef {
  id: MobileTabId;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

export const MOBILE_TABS: MobileTabDef[] = [
  { id: 'cockpit', label: 'Cockpit', shortLabel: 'Home', icon: LayoutDashboard },
  { id: 'positions', label: 'Positions', shortLabel: 'Book', icon: Wallet },
  { id: 'brain', label: 'AI Brain', shortLabel: 'AI', icon: Brain },
  { id: 'risk', label: 'Risk', shortLabel: 'Risk', icon: Shield },
  { id: 'terminal', label: 'Terminal', shortLabel: 'Ops', icon: Terminal },
  { id: 'settings', label: 'Settings', shortLabel: 'Set', icon: Settings },
];

export function mobileTabIndex(id: MobileTabId): number {
  return MOBILE_TABS.findIndex((t) => t.id === id);
}

export function clampTabIndex(i: number): number {
  return Math.max(0, Math.min(MOBILE_TABS.length - 1, i));
}
