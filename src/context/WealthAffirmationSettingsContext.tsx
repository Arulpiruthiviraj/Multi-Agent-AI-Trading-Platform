/**
 * ==========================================================
 * COMPONENT: WealthAffirmationSettingsContext
 *
 * Browser-only mindset preferences (default all false):
 * - enableWealthAffirmations
 * - enableHyperAbundanceMode
 * - enableDivineWealthMode
 * Never sent to backend; never touches EventBus / RiskEngine / P&L.
 * ==========================================================
 */
import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const KEY_AFFIRM = 'argus_enable_wealth_affirmations';
const KEY_HYPER = 'argus_enable_hyper_abundance_mode';
const KEY_DIVINE = 'argus_enable_divine_wealth_mode';

function readBool(key: string, fallback = false): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode / quota */
  }
}

interface WealthAffirmationSettings {
  enableWealthAffirmations: boolean;
  setEnableWealthAffirmations: (enabled: boolean) => void;
  enableHyperAbundanceMode: boolean;
  setEnableHyperAbundanceMode: (enabled: boolean) => void;
  enableDivineWealthMode: boolean;
  setEnableDivineWealthMode: (enabled: boolean) => void;
}

const WealthAffirmationSettingsContext = createContext<WealthAffirmationSettings | null>(null);

export function WealthAffirmationSettingsProvider({ children }: { children: ReactNode }) {
  const [enableWealthAffirmations, setAffirm] = useState(() => readBool(KEY_AFFIRM, false));
  const [enableHyperAbundanceMode, setHyper] = useState(() => readBool(KEY_HYPER, false));
  const [enableDivineWealthMode, setDivine] = useState(() => readBool(KEY_DIVINE, false));

  const setEnableWealthAffirmations = useCallback((enabled: boolean) => {
    setAffirm(enabled);
    writeBool(KEY_AFFIRM, enabled);
  }, []);

  const setEnableHyperAbundanceMode = useCallback((enabled: boolean) => {
    setHyper(enabled);
    writeBool(KEY_HYPER, enabled);
  }, []);

  const setEnableDivineWealthMode = useCallback((enabled: boolean) => {
    setDivine(enabled);
    writeBool(KEY_DIVINE, enabled);
  }, []);

  const value = useMemo(
    () => ({
      enableWealthAffirmations,
      setEnableWealthAffirmations,
      enableHyperAbundanceMode,
      setEnableHyperAbundanceMode,
      enableDivineWealthMode,
      setEnableDivineWealthMode,
    }),
    [
      enableWealthAffirmations,
      setEnableWealthAffirmations,
      enableHyperAbundanceMode,
      setEnableHyperAbundanceMode,
      enableDivineWealthMode,
      setEnableDivineWealthMode,
    ],
  );

  return (
    <WealthAffirmationSettingsContext.Provider value={value}>
      {children}
    </WealthAffirmationSettingsContext.Provider>
  );
}

export function useWealthAffirmationSettings(): WealthAffirmationSettings {
  const ctx = useContext(WealthAffirmationSettingsContext);
  if (!ctx) {
    return {
      enableWealthAffirmations: false,
      setEnableWealthAffirmations: () => {},
      enableHyperAbundanceMode: false,
      setEnableHyperAbundanceMode: () => {},
      enableDivineWealthMode: false,
      setEnableDivineWealthMode: () => {},
    };
  }
  return ctx;
}
