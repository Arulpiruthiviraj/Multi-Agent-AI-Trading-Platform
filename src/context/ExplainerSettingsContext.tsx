/**
 * ==========================================================
 * COMPONENT: ExplainerSettingsContext
 *
 * Global tooltipsEnabled flag for educational hover explainers.
 * Persisted in localStorage (`argus_tooltips_enabled`). Default on.
 * Not a trading safety setting and not sent to the backend.
 * ==========================================================
 */
import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'argus_tooltips_enabled';

function readStored(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

interface ExplainerSettings {
  tooltipsEnabled: boolean;
  setTooltipsEnabled: (enabled: boolean) => void;
}

const ExplainerSettingsContext = createContext<ExplainerSettings | null>(null);

export function ExplainerSettingsProvider({ children }: { children: ReactNode }) {
  const [tooltipsEnabled, setEnabled] = useState<boolean>(readStored);

  const setTooltipsEnabled = useCallback((enabled: boolean) => {
    setEnabled(enabled);
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {
      /* private mode / quota — keep in-memory only */
    }
  }, []);

  const value = useMemo(() => ({ tooltipsEnabled, setTooltipsEnabled }), [tooltipsEnabled, setTooltipsEnabled]);

  return (
    <ExplainerSettingsContext.Provider value={value}>
      {children}
    </ExplainerSettingsContext.Provider>
  );
}

export function useExplainerSettings(): ExplainerSettings {
  const ctx = useContext(ExplainerSettingsContext);
  if (!ctx) {
    return {
      tooltipsEnabled: true,
      setTooltipsEnabled: () => {},
    };
  }
  return ctx;
}
