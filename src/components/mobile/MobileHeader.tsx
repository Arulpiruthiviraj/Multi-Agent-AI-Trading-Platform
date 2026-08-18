import React, { useState } from 'react';
import { AlertOctagon, Power, Wifi } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { fmtUsd, modeChipClass, sessionChipClass } from './mobileUtils';
import { MobileBottomSheet } from './MobileBottomSheet';
import { toggleAutobotRemote, triggerEmergencyStop } from './useMobileMissionData';

interface MobileHeaderProps {
  onRefresh?: () => void;
}

export function MobileHeader({ onRefresh }: MobileHeaderProps) {
  const tradingMode = useMobileMissionSelector((s) => s.tradingMode);
  const tradingState = useMobileMissionSelector((s) => s.tradingState);
  const marketSession = useMobileMissionSelector((s) => s.marketSession);
  const wsStatus = useMobileMissionSelector((s) => s.wsStatus);
  const wsLatencyMs = useMobileMissionSelector((s) => s.wsLatencyMs);
  const autobotEnabled = useMobileMissionSelector((s) => s.autobotEnabled);
  const emergencyStopActive = useMobileMissionSelector((s) => s.emergencyStopActive);
  const actionBanner = useMobileMissionSelector((s) => s.actionBanner);
  const sessionExpired = useMobileMissionSelector((s) => s.sessionExpired);
  const [killStep, setKillStep] = useState<0 | 1 | 2>(0);
  const [killError, setKillError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const onToggleAutobot = async () => {
    setToggling(true);
    setToggleError(null);
    const res = await toggleAutobotRemote(autobotEnabled);
    if (!res.ok) setToggleError(res.error || 'Toggle failed');
    else onRefresh?.();
    setToggling(false);
  };

  const onConfirmKill = async () => {
    setKillError(null);
    const res = await triggerEmergencyStop();
    if (!res.ok) {
      setKillError(res.error || 'Emergency stop failed');
      return;
    }
    onRefresh?.();
    setKillStep(0);
  };

  return (
    <>
      <header
        className="sticky top-0 z-20 border-b border-slate-800 bg-[#1A1F2B]/95 backdrop-blur-md px-3 py-3"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-base font-bold text-white tracking-tight">Mission Control</h1>
            <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">ARGUS Mobile</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <span className={`text-[9px] font-mono uppercase px-2 py-1 rounded border ${modeChipClass(tradingMode)}`}>
              {tradingMode}
            </span>
            <span className={`text-[9px] font-mono uppercase px-2 py-1 rounded border ${sessionChipClass(marketSession)}`}>
              {marketSession.replace(/_/g, ' ')}
            </span>
            <span className={`text-[9px] font-mono uppercase px-2 py-1 rounded border ${
              tradingState === 'TRADING_ENABLED' ? 'bg-slate-700/40 text-slate-400 border-slate-600' : 'bg-rose-500/15 text-rose-300 border-rose-500/40'
            }`}>
              {tradingState.replace(/_/g, ' ')}
            </span>
          </div>
        </div>

        {sessionExpired && (
          <p className="mb-2 text-[10px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            Session expired — please log in again on this device.
          </p>
        )}

        {actionBanner && (
          <p className={`mb-2 text-[10px] font-mono rounded px-2 py-1.5 border ${
            actionBanner.tone === 'success'
              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
              : actionBanner.tone === 'danger'
                ? 'text-rose-300 bg-rose-500/10 border-rose-500/40'
                : 'text-rose-300 bg-rose-500/10 border-rose-500/30'
          }`}>
            {actionBanner.message}
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
            <Wifi size={14} className={wsStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'} />
            <span>{wsStatus}</span>
            <span className="text-slate-600">|</span>
            <span>{wsLatencyMs == null ? '-- ms' : `${wsLatencyMs} ms`}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={toggling || emergencyStopActive}
              onClick={() => { void onToggleAutobot(); }}
              className={`min-h-[44px] min-w-[44px] px-3 rounded-lg border text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${
                autobotEnabled
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-slate-800 border-slate-700 text-slate-400'
              } ${toggling ? 'opacity-60 animate-pulse' : ''}`}
            >
              <Power size={14} className={toggling ? 'animate-spin' : ''} />
              {toggling ? '…' : autobotEnabled ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              onClick={() => setKillStep(1)}
              className="min-h-[44px] min-w-[44px] px-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1"
            >
              <AlertOctagon size={14} />
              Kill
            </button>
          </div>
        </div>

        {(toggleError || emergencyStopActive) && (
          <p className="mt-2 text-[10px] font-mono text-rose-400">
            {emergencyStopActive ? 'Emergency stop active — engines halted.' : toggleError}
          </p>
        )}
      </header>

      <MobileBottomSheet open={killStep >= 1} title="Emergency kill switch" onClose={() => setKillStep(0)} danger>
        {killStep === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-300 leading-relaxed">
              This posts to <code className="text-rose-300">POST /api/v1/system/emergency-stop</code> and halts new entries. Existing positions are not auto-flattened.
            </p>
            <button
              type="button"
              onClick={() => setKillStep(2)}
              className="w-full min-h-[44px] rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold uppercase tracking-wider text-xs"
            >
              Continue — step 2 of 2
            </button>
          </div>
        )}
        {killStep === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-rose-200 font-mono uppercase tracking-wider">Confirm emergency stop</p>
            <p className="text-xs text-slate-400">This cannot be undone from mobile. Resume requires desktop operator action.</p>
            {killError && <p className="text-xs text-rose-400">{killError}</p>}
            <button
              type="button"
              onClick={() => { void onConfirmKill(); }}
              className="w-full min-h-[48px] rounded-lg bg-rose-700 hover:bg-rose-600 text-white font-bold uppercase tracking-widest text-xs border border-rose-400/50"
            >
              Execute emergency stop
            </button>
          </div>
        )}
      </MobileBottomSheet>
    </>
  );
}
