import { useEffect } from 'react';
import { useWebSocket } from '../../context/WebSocketContext';

/** On tab visibility/focus resume, force WS reconnect with existing exponential backoff. */
export function useMobileWsResume(enabled: boolean) {
  const { forceReconnect } = useWebSocket();

  useEffect(() => {
    if (!enabled) return;

    const onResume = () => {
      if (document.visibilityState === 'visible') {
        forceReconnect();
      }
    };

    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [enabled, forceReconnect]);
}
