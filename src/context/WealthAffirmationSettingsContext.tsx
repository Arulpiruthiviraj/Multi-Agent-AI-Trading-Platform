/**
 * ==========================================================
 * COMPONENT: WealthAffirmationSettingsContext
 *
 * Browser-only mindset preference for the Divine Wealth &
 * Hyper-Abundance Vortex (master toggle + intensity mode + sound).
 * Never sent to backend; never touches EventBus / RiskEngine / P&L.
 * ==========================================================
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_WEALTH_VORTEX,
  loadWealthVortexSettings,
  saveWealthVortexSettings,
  type WealthVortexMode,
  type WealthVortexSettings,
} from './wealthVortexStore';
import { playWealthChime } from './wealthVortexSound';

interface WealthAffirmationSettings {
  enabled: boolean;
  mode: WealthVortexMode;
  sound: boolean;
  setEnabled: (enabled: boolean) => void;
  setMode: (mode: WealthVortexMode) => void;
  setSound: (sound: boolean) => void;
  /** Convenience: active intensity when master is on. */
  activeMode: WealthVortexMode | null;
}

const WealthAffirmationSettingsContext = createContext<WealthAffirmationSettings | null>(null);

function persist(next: WealthVortexSettings) {
  saveWealthVortexSettings(next);
}

export function WealthAffirmationSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<WealthVortexSettings>(() => loadWealthVortexSettings());

  const setEnabled = useCallback((enabled: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, enabled };
      persist(next);
      if (enabled && next.sound) playWealthChime();
      return next;
    });
  }, []);

  const setMode = useCallback((mode: WealthVortexMode) => {
    setSettings((prev) => {
      const next = { ...prev, mode };
      persist(next);
      return next;
    });
  }, []);

  const setSound = useCallback((sound: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, sound };
      persist(next);
      if (sound) playWealthChime();
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      enabled: settings.enabled,
      mode: settings.mode,
      sound: settings.sound,
      setEnabled,
      setMode,
      setSound,
      activeMode: settings.enabled ? settings.mode : null,
    }),
    [settings.enabled, settings.mode, settings.sound, setEnabled, setMode, setSound],
  );

  return (
    <WealthAffirmationSettingsContext.Provider value={value}>
      {children}
    </WealthAffirmationSettingsContext.Provider>
  );
}

const FALLBACK: WealthAffirmationSettings = {
  enabled: false,
  mode: DEFAULT_WEALTH_VORTEX.mode,
  sound: false,
  setEnabled: () => {},
  setMode: () => {},
  setSound: () => {},
  activeMode: null,
};

export function useWealthAffirmationSettings(): WealthAffirmationSettings {
  const ctx = useContext(WealthAffirmationSettingsContext);
  return ctx ?? FALLBACK;
}
