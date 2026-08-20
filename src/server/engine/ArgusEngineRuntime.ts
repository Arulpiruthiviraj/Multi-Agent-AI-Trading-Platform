/**
 * Argus Engine daemon boundary — execution/runtime wrapper, not a second trading brain.
 *
 * Boots the EXISTING Argus Core via ArgusRuntime / ArgusCoreBoot.
 * Does not import React, Vite, OMS, RiskEngine, or BrokerManager.
 */
import { argusRuntime } from '../core/ArgusRuntime';
import { isArgusEngineDaemon, isWebUiEnabled } from '../app/runtimeConfig';

export async function startArgusEngineCore(): Promise<void> {
  await argusRuntime.initialize();
}

export function getArgusEngineStatus() {
  const status = argusRuntime.status();
  return {
    ...status,
    engine: {
      daemon: isArgusEngineDaemon(),
      webUiEnabled: isWebUiEnabled(),
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
    },
  };
}

export function getArgusEngineHealth() {
  return {
    ...argusRuntime.health(),
    daemon: isArgusEngineDaemon(),
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

export async function stopArgusEngineCore(opts?: { reason?: string; actor?: string }) {
  return argusRuntime.stop({
    reason: opts?.reason ?? 'Engine daemon stop',
    actor: opts?.actor ?? 'ArgusEngineRuntime',
  });
}
