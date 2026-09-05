import type { LucideIcon } from 'lucide-react';
import {
  Activity, BarChart2, BookOpen, BrainCircuit, Clock, FileText,
  Layers, LineChart, Newspaper, Search, Settings, Shield, Sunrise, Terminal, TrendingUp, Zap,
} from 'lucide-react';

export type AppTabId =
  | 'dashboard' | 'command' | 'portfolio' | 'arena' | 'news' | 'opportunities'
  | 'scanner' | 'agents' | 'evaluation' | 'kronos' | 'learning' | 'premarket'
  | 'memory' | 'observatory' | 'activity' | 'diagnostics' | 'audit' | 'validation'
  | 'settings' | 'documentation';

export type NavDomain = 'trade' | 'agents' | 'quant' | 'system';

export type TabDef = {
  id: AppTabId;
  label: string;
  icon: LucideIcon;
  domain: NavDomain;
};

export const ALL_TABS: TabDef[] = [
  { id: 'dashboard', label: 'Autonomous Dashboard', icon: Activity, domain: 'trade' },
  { id: 'command', label: 'Mission Control', icon: Zap, domain: 'trade' },
  { id: 'portfolio', label: 'Holdings & Positions', icon: Layers, domain: 'trade' },
  { id: 'arena', label: 'Trading Arena', icon: TrendingUp, domain: 'trade' },
  { id: 'agents', label: 'Agent Network', icon: BrainCircuit, domain: 'agents' },
  { id: 'evaluation', label: 'Agent Evaluation', icon: BarChart2, domain: 'agents' },
  { id: 'memory', label: 'Vec Event Memory', icon: Search, domain: 'agents' },
  { id: 'activity', label: 'System Activity', icon: Terminal, domain: 'agents' },
  { id: 'observatory', label: 'Transaction Observatory', icon: Clock, domain: 'agents' },
  { id: 'scanner', label: 'Strategy Scanner', icon: LineChart, domain: 'quant' },
  { id: 'learning', label: 'Learning & Evolution', icon: BookOpen, domain: 'quant' },
  { id: 'kronos', label: 'Kronos Forecast', icon: Activity, domain: 'quant' },
  { id: 'opportunities', label: 'Opportunity Feed', icon: TrendingUp, domain: 'quant' },
  { id: 'premarket', label: 'Premarket Intelligence', icon: Sunrise, domain: 'quant' },
  { id: 'news', label: 'News Dashboard', icon: Newspaper, domain: 'system' },
  { id: 'settings', label: 'Settings', icon: Settings, domain: 'system' },
  { id: 'diagnostics', label: 'Diagnostics', icon: Terminal, domain: 'system' },
  { id: 'audit', label: 'Audit Trail', icon: Shield, domain: 'system' },
  { id: 'validation', label: 'System Validation', icon: Shield, domain: 'system' },
  { id: 'documentation', label: 'Documentation', icon: FileText, domain: 'system' },
];

export const NAV_DOMAINS: { id: NavDomain; label: string; icon: LucideIcon; defaultTab: AppTabId }[] = [
  { id: 'trade', label: 'Trade', icon: TrendingUp, defaultTab: 'dashboard' },
  { id: 'agents', label: 'Agents', icon: BrainCircuit, defaultTab: 'agents' },
  { id: 'quant', label: 'Quant', icon: LineChart, defaultTab: 'scanner' },
  { id: 'system', label: 'System', icon: Settings, defaultTab: 'settings' },
];

export function tabsForDomain(domain: NavDomain): TabDef[] {
  return ALL_TABS.filter((t) => t.domain === domain);
}

export function domainForTab(tab: AppTabId): NavDomain {
  return ALL_TABS.find((t) => t.id === tab)?.domain ?? 'trade';
}

export function tabDef(tab: AppTabId): TabDef | undefined {
  return ALL_TABS.find((t) => t.id === tab);
}
