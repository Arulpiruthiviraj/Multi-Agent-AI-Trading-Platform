import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveIbkrHealthProbeMode,
  probeIbkrEcosystemHealth,
} from './ibkrEcosystemHealth';
import * as tcp from '../../brokers/ibkrTcpProbe';

describe('resolveIbkrHealthProbeMode', () => {
  it('maps ibkr_gateway to socket and ibkr_web to web_api', () => {
    expect(resolveIbkrHealthProbeMode('ibkr_gateway', 'socket')).toBe('socket');
    expect(resolveIbkrHealthProbeMode('IBKR Gateway (Socket)', 'web_api')).toBe('socket');
    expect(resolveIbkrHealthProbeMode('ibkr_web', 'socket')).toBe('web_api');
    expect(resolveIbkrHealthProbeMode('IBKR Web API (Client Portal)', 'socket')).toBe('web_api');
  });

  it('maps alpaca / internal_paper to standby so inactive IBKR is not FAILED', () => {
    expect(resolveIbkrHealthProbeMode('alpaca', 'socket')).toBe('standby');
    expect(resolveIbkrHealthProbeMode('Simulation Mode', 'socket')).toBe('standby');
    expect(resolveIbkrHealthProbeMode('internal_paper', 'web_api')).toBe('standby');
  });

  it('maps legacy ibkr alias via connection mode', () => {
    expect(resolveIbkrHealthProbeMode('ibkr', 'socket')).toBe('socket');
    expect(resolveIbkrHealthProbeMode('Interactive Brokers', 'web_api')).toBe('web_api');
  });
});

describe('probeIbkrEcosystemHealth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns DISABLED standby when active broker is alpaca', async () => {
    const spy = vi.spyOn(tcp, 'findFirstOpenTcpPort');
    const r = await probeIbkrEcosystemHealth({ activeBrokerIdOrName: 'alpaca' });
    expect(r.health).toBe('DISABLED');
    expect(r.probeMode).toBe('standby');
    expect(r.detail).toMatch(/STANDBY|INACTIVE/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('READY on socket mode when TCP 4002 is open', async () => {
    vi.spyOn(tcp, 'findFirstOpenTcpPort').mockResolvedValue(4002);
    const r = await probeIbkrEcosystemHealth({
      activeBrokerIdOrName: 'ibkr_gateway',
      sessionAccountId: 'DUR959160',
    });
    expect(r.health).toBe('READY');
    expect(r.probeMode).toBe('socket');
    expect(r.detail).toMatch(/IB Gateway Socket Connected \(Port 4002\)/);
    expect(r.detail).toMatch(/DUR959160 verified/);
    expect(r.action).toBeNull();
  });

  it('FAILED on socket mode when ports are closed', async () => {
    vi.spyOn(tcp, 'findFirstOpenTcpPort').mockResolvedValue(null);
    const r = await probeIbkrEcosystemHealth({ activeBrokerIdOrName: 'ibkr_gateway' });
    expect(r.health).toBe('FAILED');
    expect(r.action).toMatch(/Launch IB Gateway Desktop in Paper mode/i);
  });
});
