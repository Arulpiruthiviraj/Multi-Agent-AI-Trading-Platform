/**
 * Overview screen: engine, market, portfolio, agents, risk at a glance.
 * Read-only; all data from existing endpoints.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, KV, DataTable } from '../components.js';
import { Badge, theme } from '../theme.js';

const dash = (v: unknown) => (v === undefined || v === null || v === '' ? <Text color={theme.dim}>—</Text> : <Text>{String(v)}</Text>);

export function OverviewScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const status = usePoll(client, (c) => c.status(), 2000, refreshTick);
  const health = usePoll(client, (c) => c.health(), 5000, refreshTick);
  const portfolio = usePoll(client, (c) => c.portfolio(), 5000, refreshTick);

  const s: any = status.data;
  const pf: any = portfolio.data?.portfolio;

  const holdings: any[] = Array.isArray(pf) ? pf : [];
  let totalUnrealized = 0;
  for (const p of holdings) {
    const u = Number(p.unrealizedPnl ?? p.unrealizedPL ?? 0);
    if (Number.isFinite(u)) totalUnrealized += u;
  }

  return (
    <Box>
      <Box flexDirection="column" width="50%">
        <Panel title="ENGINE">
          <KV k="State" v={dash(s?.tradingState ?? s?.status?.tradingState)} />
          <KV k="PID" v={dash(s?.pid ?? s?.status?.pid)} />
          <KV k="Uptime" v={s?.uptimeSec != null ? `${Math.round(Number(s.uptimeSec) / 60)} min` : <Text color={theme.dim}>—</Text>} />
          <KV k="Health" v={health.data?.ok === false ? <Badge tone="err">DEGRADED</Badge> : health.data ? <Badge tone="ok">OK</Badge> : <Text color={theme.dim}>…</Text>} />
          {status.error && <Text color={theme.err}>{status.error}</Text>}
        </Panel>
        <Panel title="PORTFOLIO">
          <KV k="Positions" v={dash(holdings.length || undefined)} />
          <KV
            k="Unrealized P&L"
            v={holdings.length ? (
              <Text color={totalUnrealized > 0 ? theme.ok : totalUnrealized < 0 ? theme.err : theme.dim}>
                {totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)}
              </Text>
            ) : <Text color={theme.dim}>—</Text>}
          />
        </Panel>
      </Box>
      <Box flexDirection="column" width="50%">
        <Panel title="TOP POSITIONS">
          <DataTable
            columns={[{ header: 'Symbol', width: 10 }, { header: 'Qty', width: 8 }, { header: 'Unrl P&L', width: 14 }]}
            emptyText="(no open positions)"
            rows={holdings.slice(0, 6).map((p) => {
              const u = Number(p.unrealizedPnl ?? p.unrealizedPL ?? 0);
              return [
                <Text bold>{String(p.symbol ?? p.ticker ?? '?')}</Text>,
                String(p.quantity ?? p.qty ?? 0),
                <Text color={u > 0 ? theme.ok : u < 0 ? theme.err : theme.dim}>
                  {Number.isFinite(u) ? `${u >= 0 ? '+' : ''}$${u.toFixed(2)}` : '—'}
                </Text>,
              ];
            })}
          />
        </Panel>
        <Panel title="NOTES">
          <Text color={theme.dim}>Read-only overview. Press 2-7 for detail pages.</Text>
          <Text color={theme.dim}>r refreshes · ? shows shortcuts</Text>
        </Panel>
      </Box>
    </Box>
  );
}
