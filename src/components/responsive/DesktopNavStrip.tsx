import React from 'react';
import { motion } from 'motion/react';
import {
  Activity, AlertTriangle, BarChart3, BookOpen, BrainCircuit, Clock, Cpu,
  Layers, List, Newspaper, Search, Settings, Shield, ShieldCheck,
  Target, Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppTabId } from './responsiveNavConfig';
import { NavTabTooltip } from './NavTabTooltip';

const TAB_BTN =
  'whitespace-nowrap flex-shrink-0 px-2.5 py-2 text-[9px] font-mono font-medium border-b-2 transition-all flex items-center gap-1.5';

function tabClass(active: boolean, accent: 'emerald' | 'amber' = 'emerald'): string {
  if (active && accent === 'amber') {
    return `${TAB_BTN} border-amber-500 text-amber-400 bg-amber-500/[0.02]`;
  }
  if (active) {
    return `${TAB_BTN} border-emerald-500 text-emerald-400 bg-emerald-500/[0.02]`;
  }
  return `${TAB_BTN} border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800`;
}

type StripItem = {
  id: AppTabId;
  label: string;
  icon: LucideIcon;
  buttonId: string;
  accent?: 'emerald' | 'amber';
};

const GROUPS: StripItem[][] = [
  [
    { id: 'dashboard', label: 'AUTONOMOUS DASHBOARD', icon: Activity, buttonId: 'tab-dashboard-btn' },
    { id: 'command', label: 'MISSION CONTROL', icon: Cpu, buttonId: 'tab-command-btn' },
    { id: 'portfolio', label: 'HOLDINGS & POSITIONS', icon: Wallet, buttonId: 'tab-portfolio-btn' },
    { id: 'arena', label: 'TRADING ARENA', icon: Layers, buttonId: 'tab-arena-btn' },
  ],
  [
    { id: 'news', label: 'NEWS INTEL', icon: Newspaper, buttonId: 'tab-news-btn' },
    { id: 'opportunities', label: 'OPPORTUNITY FEED', icon: Target, buttonId: 'tab-opportunities-btn' },
    { id: 'scanner', label: 'STRATEGY SCANNER', icon: Activity, buttonId: 'tab-scanner-btn' },
  ],
  [
    { id: 'agents', label: 'AGENT NETWORK', icon: BarChart3, buttonId: 'tab-agents-btn' },
    { id: 'evaluation', label: 'AGENT EVALUATION', icon: Activity, buttonId: 'tab-evaluation-btn' },
    { id: 'kronos', label: 'KRONOS MODEL', icon: BrainCircuit, buttonId: 'tab-kronos-btn' },
    { id: 'learning', label: 'LEARNING & EVOLUTION', icon: BrainCircuit, buttonId: 'tab-learning-btn' },
    { id: 'memory', label: 'VEC EVENT MEMORY', icon: Clock, buttonId: 'tab-memory-btn' },
  ],
  [
    { id: 'observatory', label: 'OBSERVATORY', icon: Search, buttonId: 'tab-observatory-btn' },
    { id: 'activity', label: 'ACTIVITY LOG', icon: List, buttonId: 'tab-activity-btn' },
    { id: 'diagnostics', label: 'DIAGNOSTICS', icon: AlertTriangle, buttonId: 'tab-diagnostics-btn', accent: 'amber' },
    { id: 'audit', label: 'OBSERVABILITY & TRACING', icon: Shield, buttonId: 'tab-audit-btn' },
  ],
  [
    { id: 'validation', label: 'VALIDATION', icon: ShieldCheck, buttonId: 'tab-validation-btn' },
    { id: 'settings', label: 'SETTINGS & KEYS', icon: Settings, buttonId: 'tab-settings-btn' },
    { id: 'documentation', label: 'DOCUMENTATION', icon: BookOpen, buttonId: 'tab-documentation-btn' },
  ],
];

function AgentsTabButton({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect: (tab: AppTabId) => void;
}): React.ReactElement {
  return (
    <NavTabTooltip tabId="agents">
      <motion.button
        id="tab-agents-btn"
        type="button"
        onClick={() => onSelect('agents')}
        className={`relative whitespace-nowrap flex-shrink-0 px-2.5 py-2 text-[9px] font-mono font-medium border-b-2 transition-all flex items-center gap-1.5 ${
          active ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-slate-400'
        }`}
        whileHover={
          !active
            ? {
                backgroundColor: [
                  'rgba(30, 41, 59, 1)',
                  'rgba(16, 185, 129, 0.1)',
                  'rgba(30, 41, 59, 1)',
                ],
                color: '#e2e8f0',
                transition: { duration: 1.5, repeat: Infinity, ease: 'easeInOut' },
              }
            : undefined
        }
        animate={
          active
            ? {
                backgroundColor: [
                  'rgba(16, 185, 129, 0.02)',
                  'rgba(16, 185, 129, 0.15)',
                  'rgba(16, 185, 129, 0.02)',
                ],
              }
            : {}
        }
        transition={active ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : {}}
      >
        <BarChart3 size={14} />
        AGENT NETWORK
        {active && (
          <motion.span
            className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-emerald-400"
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </motion.button>
    </NavTabTooltip>
  );
}

export function DesktopNavStrip({
  activeTab,
  onSelectTab,
}: {
  activeTab: string;
  onSelectTab: (tab: AppTabId) => void;
}): React.ReactElement {
  return (
    <nav className="flex flex-wrap gap-x-0 gap-y-0 py-0.5 items-center" aria-label="Tabs navigation">
      {GROUPS.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <div className="w-px h-5 bg-slate-800 mx-2 flex-shrink-0" />}
          {group.map((item) => {
            if (item.id === 'agents') {
              return (
                <React.Fragment key={item.id}>
                  <AgentsTabButton
                    active={activeTab === 'agents'}
                    onSelect={onSelectTab}
                  />
                </React.Fragment>
              );
            }
            const Icon = item.icon;
            return (
              <React.Fragment key={item.id}>
                <NavTabTooltip tabId={item.id}>
                  <button
                    id={item.buttonId}
                    type="button"
                    onClick={() => onSelectTab(item.id)}
                    className={tabClass(activeTab === item.id, item.accent)}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                </NavTabTooltip>
              </React.Fragment>
            );
          })}
        </React.Fragment>
      ))}
    </nav>
  );
}
