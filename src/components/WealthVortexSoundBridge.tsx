/**
 * Plays a soft wealth chime on ORDER_EXECUTED FILLED when sound is enabled.
 * Browser theater only — does not affect order handling.
 */
import { useEffect } from 'react';
import { useWebSocket } from '../context/WebSocketContext';
import { useWealthAffirmationSettings } from '../context/WealthAffirmationSettingsContext';
import { playWealthChime } from '../context/wealthVortexSound';

export function WealthVortexSoundBridge() {
  const { subscribe } = useWebSocket();
  const { enabled, sound } = useWealthAffirmationSettings();

  useEffect(() => {
    if (!enabled || !sound) return;
    const unsub = subscribe('ORDER_EXECUTED', (data: { status?: string }) => {
      if (data?.status === 'FILLED') playWealthChime();
    });
    return () => unsub();
  }, [enabled, sound, subscribe]);

  return null;
}
