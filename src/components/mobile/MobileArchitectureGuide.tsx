/**
 * Mobile-exclusive "How Argus Works" guide. Plain-English, non-technical explanation of the
 * dual-loop architecture, rendered inside the shared MobileBottomSheet drawer. Pure frontend —
 * no backend calls, no trading-path changes. Triggered from MobileTopBar's info button.
 */
import React, { useState } from 'react';
import { ChevronDown, Search, Users, Scale, ShieldCheck, Zap, RefreshCw, Sparkles, Shield } from 'lucide-react';

interface FlowStep {
  icon: React.ReactNode;
  title: string;
  summary: string;
}

const FLOW_STEPS: FlowStep[] = [
  { icon: <Search size={16} />, title: 'Step 1: The Scout Scans the Market', summary: 'Continuously looks across the market and filters out illiquid or low-quality names.' },
  { icon: <Users size={16} />, title: 'Step 2: The AI Committee Debates', summary: 'Chart, forecast, fundamental, and macro specialists each weigh in on whether the setup is worth pursuing.' },
  { icon: <Scale size={16} />, title: 'Step 3: The 2-Person Rule', summary: 'At least 2 independent analysts must strongly agree (≥75% confidence), or Argus walks away.' },
  { icon: <ShieldCheck size={16} />, title: 'Step 4: The 24-Gate Safety Vault', summary: 'Pre-trade checks verify budget limits, spread quality, and every other safety rule.' },
  { icon: <Zap size={16} />, title: 'Step 5: Safe Paper Execution', summary: 'The order is sent to your simulated paper broker account — never real money.' },
  { icon: <RefreshCw size={16} />, title: 'Step 6: 24/7 Position Guard', summary: 'The portfolio loop watches every open trade to lock in profit or cut losses quickly.' },
];

interface AccordionSection {
  id: string;
  emoji: string;
  title: string;
  body: React.ReactNode;
}

const SECTIONS: AccordionSection[] = [
  {
    id: 'what-is-argus',
    emoji: '🌟',
    title: 'What is Argus? (A Hedge Fund in Your Pocket)',
    body: (
      <p>
        Argus acts like an entire Wall Street trading desk working for you — specialized AI analysts, a risk manager, and an execution
        clerk, all working together in milliseconds. It operates in simulated <b className="text-white">Paper Trading</b> mode, so you can
        watch it work with <b className="text-emerald-400">zero risk to real money</b>.
      </p>
    ),
  },
  {
    id: 'two-engines',
    emoji: '🔄',
    title: 'The Two Engines: The Hunter & The Guard',
    body: (
      <div className="space-y-2">
        <p><b className="text-white">The Hunter (buying):</b> constantly looks for new, high-probability setups across the market.</p>
        <p><b className="text-white">The Guard (selling):</b> watches everything you already own, taking profit when a stock runs and cutting losses quickly if momentum fades.</p>
      </div>
    ),
  },
  {
    id: 'ai-team',
    emoji: '👥',
    title: 'Meet Your Specialized AI Team',
    body: (
      <ul className="space-y-1.5 list-none">
        <li>📈 <b className="text-white">Chart Specialist</b> — reads price patterns, momentum, and trend strength.</li>
        <li>🔮 <b className="text-white">Forecaster</b> — uses probability models to predict the likely price path.</li>
        <li>🏢 <b className="text-white">Company Auditor</b> — checks business health, earnings, and valuation.</li>
        <li>🌍 <b className="text-white">Big-Picture Economist</b> — watches rates, inflation, and macro trends.</li>
        <li>📰 <b className="text-white">News Watchdog</b> — flags breaking headlines and sudden crises.</li>
      </ul>
    ),
  },
  {
    id: 'why-safe',
    emoji: '🛡️',
    title: 'Why Argus is Safe by Design',
    body: (
      <p>
        A hard budget lock caps how much Argus can ever deploy. Diversification rules stop it from putting too many eggs in one basket.
        And it never gambles on a single AI's hunch — every trade needs at least two independent analysts to agree before it's even
        considered, and it still has to clear the full risk vault after that.
      </p>
    ),
  },
];

export function MobileArchitectureGuide() {
  const [openSection, setOpenSection] = useState<string | null>(SECTIONS[0].id);

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400 leading-relaxed">
        A quick, plain-English tour of how Argus actually makes decisions — no jargon required.
      </p>

      {/* Vertical flowchart */}
      <div className="flex flex-col items-stretch">
        {FLOW_STEPS.map((step, i) => (
          <div key={step.title} className="w-full max-w-full">
            <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-[#111822] p-3">
              <div className="w-9 h-9 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 flex items-center justify-center shrink-0">
                {step.icon}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-mono uppercase tracking-wider text-emerald-400 mb-0.5">{step.title}</p>
                <p className="text-xs text-slate-300 leading-snug">{step.summary}</p>
              </div>
            </div>
            {i < FLOW_STEPS.length - 1 && (
              <div className="flex justify-center py-1">
                <ChevronDown size={16} className="text-slate-600" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Non-technical accordion sections */}
      <div className="space-y-2">
        {SECTIONS.map((section) => {
          const open = openSection === section.id;
          return (
            <div key={section.id} className="rounded-xl border border-slate-800 bg-[#111822] overflow-hidden w-full max-w-full">
              <button
                type="button"
                onClick={() => setOpenSection(open ? null : section.id)}
                className="w-full min-h-[48px] flex items-center justify-between gap-2 px-3 py-2.5 text-left"
              >
                <span className="flex items-center gap-2 text-xs font-bold text-white">
                  <span className="text-base leading-none">{section.emoji}</span>
                  {section.title}
                </span>
                <ChevronDown size={16} className={`text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div className="px-3 pb-3 text-xs text-slate-300 leading-relaxed">
                  {section.body}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#111822] p-3">
        <Sparkles size={14} className="text-cyan-400 shrink-0" />
        <p className="text-[10px] text-slate-500 leading-snug">
          This is an explanation of how the system is designed to behave, not a promise of profit. Every real decision is still logged and reviewable.
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#111822] p-3">
        <Shield size={14} className="text-emerald-400 shrink-0" />
        <p className="text-[10px] text-slate-500 leading-snug">
          Paper trading only. Nothing in this guide changes trading behavior, risk limits, or account settings.
        </p>
      </div>
    </div>
  );
}
