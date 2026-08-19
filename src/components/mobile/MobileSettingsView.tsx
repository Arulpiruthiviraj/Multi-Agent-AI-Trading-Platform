/**
 * Touch-first Mobile Settings Control Panel.
 * Overlay flags: GET/POST /api/v2/settings/overrides*.
 * Operator settings (take-profit, broker): POST /api/v1/settings.
 * Does not arm LIVE, write .env, or bypass RiskEngine.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Lock,
  Radar,
  RotateCcw,
  Search,
  Shield,
  Landmark,
  Brain,
  Layers,
  AlertTriangle,
} from 'lucide-react';
import { apiFetch } from '../../lib/clientFetch';
import tradingSafety from '../../../config/tradingSafety.json';
import continuousIntelligence from '../../../config/continuousIntelligence.json';
import multiAsset from '../../../config/multiAsset.json';
import {
  BROKER_CHOICES,
  COST_BASIS_STOP_STEPS,
  findRow,
  formatBool,
  formatEnvFallback,
  isTruthyEffective,
  LLM_PRESELECTS,
  matchesSearch,
  optimisticBoolOverride,
  optimisticResetToEnv,
  RUNTIME_KEYS,
  sourceBadge,
  TAKE_PROFIT_STEPS,
  type EffectiveRow,
} from './mobileSettingsModel';

type AccordionId = 'scan' | 'exits' | 'asset' | 'quant' | 'broker';

const ACCORDIONS: Array<{ id: AccordionId; title: string; icon: React.ReactNode; keys: string[] }> = [
  { id: 'scan', title: 'Scanning & Discovery', icon: <Radar size={16} className="text-cyan-400" />, keys: [RUNTIME_KEYS.opportunity, 'scan', 'watchlist'] },
  { id: 'exits', title: 'Portfolio & Exits', icon: <Shield size={16} className="text-emerald-400" />, keys: [RUNTIME_KEYS.portfolioIntel, 'take', 'stop', 'trail'] },
  { id: 'asset', title: 'Multi-Asset & Penny', icon: <Layers size={16} className="text-amber-400" />, keys: [RUNTIME_KEYS.multiAsset, RUNTIME_KEYS.penny, 'spread'] },
  { id: 'quant', title: 'Quant & AI Engine', icon: <Brain size={16} className="text-indigo-300" />, keys: [RUNTIME_KEYS.quant, 'llm', 'consensus', 'quorum'] },
  { id: 'broker', title: 'Broker & Execution', icon: <Landmark size={16} className="text-emerald-300" />, keys: [RUNTIME_KEYS.paperOnly, 'alpaca', 'broker'] },
];

function ToggleSwitch({
  on,
  disabled,
  onToggle,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors mobile-press ${
        disabled
          ? 'opacity-50 cursor-not-allowed border-slate-700 bg-slate-800'
          : on
            ? 'bg-emerald-500/80 border-emerald-400/50'
            : 'bg-slate-700 border-slate-600'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          on ? 'left-5' : 'left-0.5'
        }`}
      />
    </button>
  );
}

function Provenance({ row }: { row: EffectiveRow }) {
  const src = sourceBadge(row.source);
  const on = isTruthyEffective(row);
  return (
    <div className="flex flex-wrap gap-1.5 w-full max-w-full overflow-hidden">
      {row.secret ? (
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${row.configured ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-rose-300 border-rose-500/40'}`}>
          {row.configured ? 'Configured ✓' : 'Missing ✗'}
        </span>
      ) : (
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${on ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-slate-400 border-slate-700 bg-slate-800'}`}>
          Effective: {formatBool(row.effectiveValue)}
        </span>
      )}
      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${src.className}`}>{src.label}</span>
      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-slate-800 text-slate-500 break-all">
        {formatEnvFallback(row)}
      </span>
      {row.restartRequired && (
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 bg-amber-500/10">
          Restart required
        </span>
      )}
    </div>
  );
}

function SettingCard({
  title,
  description,
  children,
  row,
  onReset,
  busy,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  row?: EffectiveRow;
  onReset?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="w-full max-w-full overflow-hidden rounded-xl border border-slate-800 bg-[#0b0f17] p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-100 leading-snug break-words">{title}</p>
          <p className="text-[10px] text-slate-500 leading-snug mt-0.5 break-words">{description}</p>
        </div>
        {row?.source === 'SETTINGS' && onReset && (
          <button
            type="button"
            aria-label={`Reset ${title} to .env`}
            disabled={busy}
            onClick={onReset}
            className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-indigo-500/40 text-indigo-300"
          >
            <RotateCcw size={16} />
          </button>
        )}
      </div>
      {row && <Provenance row={row} />}
      {children}
    </div>
  );
}

export function MobileSettingsView() {
  const [rows, setRows] = useState<EffectiveRow[]>([]);
  const [resetPhrase, setResetPhrase] = useState('RESET_ALL_TO_ENV');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<AccordionId, boolean>>({
    scan: true,
    exits: false,
    asset: false,
    quant: false,
    broker: false,
  });
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [takeProfit, setTakeProfit] = useState(15);
  const [stopPct, setStopPct] = useState(5);
  const [broker, setBroker] = useState('Argus Internal Simulator');
  const [paperOnly, setPaperOnly] = useState(true);
  const [llmPreselect, setLlmPreselect] = useState('OpenAI');
  const [providerStatus, setProviderStatus] = useState<Array<{ provider: string; isConfigured: boolean }>>([]);
  const [alpacaConfigured, setAlpacaConfigured] = useState(false);
  const [keyModal, setKeyModal] = useState<{ kind: 'provider' | 'broker'; name: string } | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [secretDraft, setSecretDraft] = useState('');
  const [watchlistMax, setWatchlistMax] = useState(continuousIntelligence.maxActiveSubscriptions);
  const [pendingRestart, setPendingRestart] = useState(false);

  const load = useCallback(async () => {
    const [eff, settings, providers, brokers, intel] = await Promise.all([
      apiFetch<{ ok?: boolean; settings?: EffectiveRow[]; resetAllConfirmation?: string; error?: string }>('/api/v2/settings/effective'),
      apiFetch<Record<string, unknown>>('/api/v1/settings'),
      apiFetch<Array<{ provider: string; isConfigured: boolean }>>('/api/v1/config/provider-status'),
      apiFetch<Array<{ brokerName: string; hasApiKey?: boolean; hasSecret?: boolean }>>('/api/v1/config/brokers'),
      apiFetch<{ maxActiveSubscriptions?: number }>('/api/v2/continuous-intelligence/status'),
    ]);
    if (!eff.ok || eff.data.ok === false) throw new Error(eff.error || eff.data.error || 'Failed to load effective settings');
    const nextRows = Array.isArray(eff.data.settings) ? eff.data.settings : [];
    setRows(nextRows);
    if (typeof eff.data.resetAllConfirmation === 'string') setResetPhrase(eff.data.resetAllConfirmation);
    setPendingRestart(nextRows.some((r) => r.source === 'SETTINGS' && r.restartRequired));

    if (settings.ok) {
      const s = settings.data;
      if (typeof s.takeProfitPct === 'number') setTakeProfit(s.takeProfitPct);
      if (typeof s.trailingStopPct === 'number') setStopPct(s.trailingStopPct);
      if (typeof s.selectedBroker === 'string' && s.selectedBroker) setBroker(s.selectedBroker);
      if (typeof s.PAPER_TRADING_ONLY === 'boolean') setPaperOnly(s.PAPER_TRADING_ONLY);
      if (typeof s.selectedAiProvider === 'string' && s.selectedAiProvider) setLlmPreselect(s.selectedAiProvider);
    }
    if (providers.ok && Array.isArray(providers.data)) setProviderStatus(providers.data);
    if (brokers.ok && Array.isArray(brokers.data)) {
      const alpaca = brokers.data.find((b) => /alpaca/i.test(b.brokerName));
      setAlpacaConfigured(!!(alpaca?.hasApiKey && alpaca?.hasSecret));
    }
    if (intel.ok && typeof intel.data.maxActiveSubscriptions === 'number') {
      setWatchlistMax(intel.data.maxActiveSubscriptions);
    }
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return { scan: true, exits: true, asset: true, quant: true, broker: true };
    return {
      scan: ['opportunity', 'scan', 'watchlist', 'discovery'].some((k) => k.includes(q) || q.includes(k))
        || matchesSearch(findRow(rows, RUNTIME_KEYS.opportunity) || { setting: '', label: 'opportunity scanner', description: '', category: 'OPPORTUNITY' }, query),
      exits: ['exit', 'profit', 'stop', 'portfolio', 'trail'].some((k) => q.includes(k))
        || matchesSearch(findRow(rows, RUNTIME_KEYS.portfolioIntel) || { setting: '', label: 'portfolio', description: '', category: '' }, query),
      asset: ['penny', 'multi', 'asset', 'spread'].some((k) => q.includes(k)),
      quant: ['quant', 'llm', 'ai', 'consensus', 'quorum', 'gemini', 'openai'].some((k) => q.includes(k)),
      broker: ['broker', 'alpaca', 'ibkr', 'paper', 'key'].some((k) => q.includes(k)),
    };
  }, [q, query, rows]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load().catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const setOverride = (row: EffectiveRow, value: boolean) => {
    setRows((prev) => prev.map((r) => (r.setting === row.setting ? optimisticBoolOverride(r, value) : r)));
    if (row.restartRequired) setPendingRestart(true);
    return run(row.setting, async () => {
      const res = await apiFetch('/api/v2/settings/overrides', {
        method: 'POST',
        body: JSON.stringify({ key: row.setting, value }),
      });
      if (!res.ok) throw new Error(res.error || 'Override failed');
    });
  };

  const resetOne = (row: EffectiveRow) => {
    setRows((prev) => prev.map((r) => (r.setting === row.setting ? optimisticResetToEnv(r) : r)));
    return run(`reset-${row.setting}`, async () => {
      const res = await apiFetch(`/api/v2/settings/overrides/${encodeURIComponent(row.setting)}/reset`, {
        method: 'POST',
        body: '{}',
      });
      if (!res.ok) throw new Error(res.error || 'Reset failed');
    });
  };

  const patchSettings = (body: Record<string, unknown>) =>
    run('settings', async () => {
      const res = await apiFetch('/api/v1/settings', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(res.error || 'Settings save failed');
    });

  const resetAll = () =>
    run('reset-all', async () => {
      const res = await apiFetch('/api/v2/settings/overrides/reset-all', {
        method: 'POST',
        body: JSON.stringify({ confirm: confirmText }),
      });
      if (!res.ok) throw new Error(res.error || 'Reset all failed');
      setConfirmReset(false);
      setConfirmText('');
    });

  const saveSecret = () => {
    if (!keyModal) return;
    run('secret', async () => {
      if (keyModal.kind === 'provider') {
        const res = await apiFetch('/api/v1/config/providers', {
          method: 'POST',
          body: JSON.stringify({ provider: keyModal.name, apiKey: keyDraft }),
        });
        if (!res.ok) throw new Error(res.error || 'Provider save failed');
      } else {
        const res = await apiFetch('/api/v1/config/brokers', {
          method: 'POST',
          body: JSON.stringify({
            brokerName: keyModal.name,
            apiKeyEncrypted: keyDraft,
            apiSecretEncrypted: secretDraft,
          }),
        });
        if (!res.ok) throw new Error(res.error || 'Broker save failed');
      }
      setKeyModal(null);
      setKeyDraft('');
      setSecretDraft('');
    });
  };

  const opp = findRow(rows, RUNTIME_KEYS.opportunity);
  const intel = findRow(rows, RUNTIME_KEYS.portfolioIntel);
  const multi = findRow(rows, RUNTIME_KEYS.multiAsset);
  const penny = findRow(rows, RUNTIME_KEYS.penny);
  const quant = findRow(rows, RUNTIME_KEYS.quant);
  const paperLock = findRow(rows, RUNTIME_KEYS.paperOnly);
  const scanSec = Math.round(continuousIntelligence.opportunityScanMs / 1000);
  const spreadBps = multiAsset.safety.pennyMaxSpreadBps;
  const quorum = `${tradingSafety.consensusApprovalThreshold} conf / ${tradingSafety.minIndependentAgreeingAgents} agents`;

  const Section = ({ id, children }: { id: AccordionId; children: React.ReactNode }) => {
    const meta = ACCORDIONS.find((a) => a.id === id)!;
    if (q && !visible[id]) return null;
    const expanded = q ? true : open[id];
    return (
      <div className="w-full max-w-full overflow-hidden rounded-xl border border-slate-800 bg-[#111822]/80">
        <button
          type="button"
          className="w-full max-w-full flex items-center justify-between gap-2 px-3 min-h-[48px] text-left"
          onClick={() => setOpen((s) => ({ ...s, [id]: !s[id] }))}
        >
          <span className="flex items-center gap-2 min-w-0">
            {meta.icon}
            <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-200 truncate">{meta.title}</span>
          </span>
          <ChevronDown size={16} className={`shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {expanded && <div className="px-3 pb-3 space-y-2">{children}</div>}
      </div>
    );
  };

  return (
    <div className="w-full max-w-full overflow-hidden px-3 py-3 space-y-3 bg-[#0b0f17] min-h-full">
      <div className="sticky top-0 z-20 -mx-3 px-3 py-2 bg-[#0b0f17]/95 backdrop-blur-md border-b border-slate-800/80 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings..."
              className="w-full max-w-full h-11 pl-9 pr-3 rounded-lg bg-[#111822] border border-slate-800 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </div>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="shrink-0 min-h-[44px] px-2 rounded-lg border border-rose-500/40 text-[9px] font-mono uppercase text-rose-300"
          >
            Reset all to .env
          </button>
        </div>
        {pendingRestart && (
          <p className="text-[10px] font-mono text-amber-300 border border-amber-500/30 rounded-lg px-2 py-1.5 bg-amber-500/10">
            Some overlays require a Node restart to apply.
          </p>
        )}
      </div>

      {error && <p className="text-[11px] font-mono text-rose-400 break-words">{error}</p>}
      {busy && <p className="text-[10px] font-mono text-slate-500">Saving {busy}…</p>}

      <Section id="scan">
        {opp && (
          <SettingCard title="Opportunity scanner" description={opp.description} row={opp} onReset={() => resetOne(opp)} busy={!!busy}>
            <div className="flex items-center justify-between min-h-[44px]">
              <span className="text-[10px] font-mono text-slate-400">{RUNTIME_KEYS.opportunity}</span>
              <ToggleSwitch
                label="Opportunity loop"
                on={isTruthyEffective(opp)}
                disabled={!opp.overridable || !!busy}
                onToggle={() => setOverride(opp, !isTruthyEffective(opp))}
              />
            </div>
          </SettingCard>
        )}
        <SettingCard
          title="Opportunity scan interval"
          description="Reviewed config/continuousIntelligence.json — not a Settings overlay. Scanner never emits TRADE_IDEA_GENERATED."
        >
          <p className="text-xs font-mono text-slate-300">{scanSec}s (read-only)</p>
        </SettingCard>
        <SettingCard
          title="Max watchlist subscriptions"
          description="Alpaca IEX bounded feed. Reviewed maxActiveSubscriptions — not DB-overridable."
        >
          <p className="text-xs font-mono text-slate-300">{watchlistMax} symbols (read-only)</p>
        </SettingCard>
      </Section>

      <Section id="exits">
        {intel && (
          <SettingCard title="Portfolio intelligence overlay" description={intel.description} row={intel} onReset={() => resetOne(intel)} busy={!!busy}>
            <div className="flex items-center justify-between min-h-[44px]">
              <span className="text-[10px] font-mono text-slate-400 truncate">{RUNTIME_KEYS.portfolioIntel}</span>
              <ToggleSwitch
                label="Portfolio intel"
                on={isTruthyEffective(intel)}
                disabled={!intel.overridable || !!busy}
                onToggle={() => setOverride(intel, !isTruthyEffective(intel))}
              />
            </div>
          </SettingCard>
        )}
        <SettingCard title="Take-profit target %" description="settings.takeProfitPct vs average cost. Full-position SELL idea through RiskEngine — not a broker take-profit order.">
          <div className="flex flex-wrap gap-1.5">
            {TAKE_PROFIT_STEPS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={!!busy}
                onClick={() => { setTakeProfit(n); void patchSettings({ takeProfitPct: n }); }}
                className={`min-h-[44px] min-w-[44px] px-3 rounded-lg text-xs font-mono border ${
                  takeProfit === n ? 'border-emerald-400 text-emerald-300 bg-emerald-500/15' : 'border-slate-700 text-slate-400'
                }`}
              >
                {n}%
              </button>
            ))}
          </div>
        </SettingCard>
        <SettingCard
          title="Cost-basis stop %"
          description="settings.trailingStopPct vs average cost. Not a peak-trailing stop and not ATR. There is no Dynamic Trailing ATR multiplier in the live engine."
        >
          <div className="flex flex-wrap gap-1.5">
            {COST_BASIS_STOP_STEPS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={!!busy}
                onClick={() => { setStopPct(n); void patchSettings({ trailingStopPct: n }); }}
                className={`min-h-[44px] min-w-[44px] px-3 rounded-lg text-xs font-mono border ${
                  stopPct === n ? 'border-emerald-400 text-emerald-300 bg-emerald-500/15' : 'border-slate-700 text-slate-400'
                }`}
              >
                {n}%
              </button>
            ))}
          </div>
        </SettingCard>
      </Section>

      <Section id="asset">
        {multi && (
          <SettingCard title="Multi-asset engine" description={multi.description} row={multi} onReset={() => resetOne(multi)} busy={!!busy}>
            <div className="flex justify-end min-h-[44px] items-center">
              <ToggleSwitch label="Multi-asset" on={isTruthyEffective(multi)} disabled={!multi.overridable || !!busy} onToggle={() => setOverride(multi, !isTruthyEffective(multi))} />
            </div>
          </SettingCard>
        )}
        {penny && (
          <SettingCard title="Penny stock engine" description={penny.description} row={penny} onReset={() => resetOne(penny)} busy={!!busy}>
            <div className="flex items-center justify-between gap-2 min-h-[44px]">
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300">High volatility</span>
              <ToggleSwitch label="Penny stocks" on={isTruthyEffective(penny)} disabled={!penny.overridable || !!busy} onToggle={() => setOverride(penny, !isTruthyEffective(penny))} />
            </div>
          </SettingCard>
        )}
        <SettingCard
          title="Max penny spread"
          description="Reviewed config/multiAsset.json safety.pennyMaxSpreadBps. UNCALIBRATED. Not a Settings overlay. MARKET orders remain unfit for penny."
        >
          <p className="text-xs font-mono text-slate-300">{spreadBps} bps ({(spreadBps / 100).toFixed(2)}%) · read-only</p>
        </SettingCard>
      </Section>

      <Section id="quant">
        {quant && (
          <SettingCard title="Quant engine" description={quant.description} row={quant} onReset={() => resetOne(quant)} busy={!!busy}>
            <div className="flex justify-end min-h-[44px] items-center">
              <ToggleSwitch label="Quant engine" on={isTruthyEffective(quant)} disabled={!quant.overridable || !!busy} onToggle={() => setOverride(quant, !isTruthyEffective(quant))} />
            </div>
          </SettingCard>
        )}
        <SettingCard
          title="Active LLM preselect"
          description="settings.selectedAiProvider is a UI preselect. AIRouter still uses per-agent routes. Claude extra keys do not imply a dedicated provider class."
        >
          <div className="grid grid-cols-2 gap-1.5 w-full">
            {LLM_PRESELECTS.map((name) => {
              const st = providerStatus.find((p) => p.provider === name || (name.startsWith('Ollama') && p.provider.toLowerCase().includes('ollama')));
              const configured = name.startsWith('Ollama') ? true : !!st?.isConfigured;
              const active = llmPreselect === name || llmPreselect.toLowerCase().includes(name.split(' ')[0].toLowerCase());
              return (
                <button
                  key={name}
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setLlmPreselect(name);
                    void patchSettings({ selectedAiProvider: name });
                  }}
                  className={`min-h-[44px] rounded-lg border text-[10px] font-mono px-2 ${
                    active ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-slate-700 text-slate-400'
                  }`}
                >
                  {name.replace(' (Local)', '')}
                  <span className="block text-[8px] text-slate-500">{configured ? 'Configured ✓' : 'Missing ✗'}</span>
                </button>
              );
            })}
          </div>
          {!llmPreselect.startsWith('Ollama') && (
            <button
              type="button"
              className="w-full min-h-[44px] rounded-lg border border-slate-700 text-[10px] font-mono text-slate-300"
              onClick={() => setKeyModal({ kind: 'provider', name: llmPreselect })}
            >
              Update key (never shows previous value)
            </button>
          )}
        </SettingCard>
        <SettingCard title="AI consensus quorum" description="Reviewed config/tradingSafety.json. Not overridable from Settings. ChiefTrader still requires this bar.">
          <div className="flex items-center gap-2 min-h-[44px]">
            <Lock size={14} className="text-slate-500" />
            <p className="text-xs font-mono text-slate-200">{quorum}</p>
          </div>
        </SettingCard>
      </Section>

      <Section id="broker">
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 min-h-[44px]">
          <Lock size={14} className="text-emerald-400 shrink-0" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-300">
            {paperOnly || isTruthyEffective(paperLock) ? 'Locked in paper mode' : 'PAPER_TRADING_ONLY is off (LIVE still NO-GO until arming)'}
          </span>
        </div>
        {paperLock && (
          <SettingCard title="Paper trading only" description="Safety lock. Settings cannot override PAPER_TRADING_ONLY." row={paperLock}>
            <div className="flex items-center justify-between min-h-[44px]">
              <Lock size={16} className="text-slate-500" />
              <ToggleSwitch label="Paper trading only" on={isTruthyEffective(paperLock) || paperOnly} disabled onToggle={() => {}} />
            </div>
          </SettingCard>
        )}
        <SettingCard title="Active broker" description="Persists settings.selectedBroker. BrokerManager applies on initialize — restart after change. Does not arm LIVE.">
          <div className="grid grid-cols-1 gap-1.5">
            {BROKER_CHOICES.map((b) => (
              <button
                key={b.value}
                type="button"
                disabled={!!busy}
                onClick={() => { setBroker(b.value); void patchSettings({ selectedBroker: b.value }); }}
                className={`min-h-[44px] rounded-lg border text-xs font-mono ${
                  broker === b.value || broker.includes(b.label.split(' ')[0])
                    ? 'border-emerald-400 text-emerald-200 bg-emerald-500/10'
                    : 'border-slate-700 text-slate-400'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </SettingCard>
        <SettingCard title="Alpaca API credentials" description="Status only. Tap Update Key to overwrite. Previous secret is never displayed.">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[10px] font-mono px-2 py-1 rounded border ${alpacaConfigured ? 'text-emerald-300 border-emerald-500/40' : 'text-rose-300 border-rose-500/40'}`}>
              {alpacaConfigured ? 'Configured ✓' : 'Missing ✗'}
            </span>
            <button
              type="button"
              className="min-h-[44px] px-3 rounded-lg border border-slate-600 text-[10px] font-mono text-slate-200"
              onClick={() => setKeyModal({ kind: 'broker', name: 'Alpaca' })}
            >
              Update key
            </button>
          </div>
        </SettingCard>
      </Section>

      {confirmReset && (
        <div className="fixed inset-0 z-[400] flex items-end justify-center bg-black/70 p-3" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-[#1A1F2B] p-4 space-y-3">
            <p className="text-sm font-bold text-white">Reset all overlays to .env?</p>
            <p className="text-[11px] text-slate-400">
              Deletes config_overrides only. Does not touch trades, fills, portfolio, risk, or broker credentials. Type {resetPhrase}.
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full h-11 rounded-lg bg-[#111822] border border-slate-700 px-3 text-sm font-mono text-slate-200"
              placeholder={resetPhrase}
            />
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="min-h-[44px] rounded-lg border border-slate-600 text-slate-300" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button
                type="button"
                disabled={confirmText !== resetPhrase || !!busy}
                onClick={() => void resetAll()}
                className="min-h-[44px] rounded-lg bg-rose-700 text-white font-bold text-xs uppercase disabled:opacity-40"
              >
                Confirm reset
              </button>
            </div>
          </div>
        </div>
      )}

      {keyModal && (
        <div className="fixed inset-0 z-[400] flex items-end justify-center bg-black/70 p-3" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#1A1F2B] p-4 space-y-3">
            <p className="text-sm font-bold text-white flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-400" />
              Update {keyModal.name} secret
            </p>
            <p className="text-[11px] text-slate-400">Previous value is never shown. Leave blank and cancel to abort.</p>
            <input
              type="password"
              autoComplete="new-password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="New API key"
              className="w-full h-11 rounded-lg bg-[#111822] border border-slate-700 px-3 text-sm font-mono text-slate-200"
            />
            {keyModal.kind === 'broker' && (
              <input
                type="password"
                autoComplete="new-password"
                value={secretDraft}
                onChange={(e) => setSecretDraft(e.target.value)}
                placeholder="New API secret"
                className="w-full h-11 rounded-lg bg-[#111822] border border-slate-700 px-3 text-sm font-mono text-slate-200"
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="min-h-[44px] rounded-lg border border-slate-600 text-slate-300" onClick={() => { setKeyModal(null); setKeyDraft(''); setSecretDraft(''); }}>Cancel</button>
              <button type="button" disabled={!keyDraft || !!busy} onClick={() => saveSecret()} className="min-h-[44px] rounded-lg bg-emerald-700 text-white text-xs font-bold uppercase disabled:opacity-40">
                Save (restart may be required)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MobileSettingsView;
