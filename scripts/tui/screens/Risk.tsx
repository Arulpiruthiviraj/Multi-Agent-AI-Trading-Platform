/**
 * Risk screen: RiskEngine health, limits, recent gates. STRICTLY READ-ONLY.
 * The TUI never bypasses, reconfigures, or softens RiskEngine.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, KV, DataTable, Badge } from '../components.js';
import { theme } from '../theme.js';

export function RiskScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const risk = usePoll(client, (c) => c.risk(), 5000, refreshTick);

  const r: any = risk.data;
  const gates: any[] = Array.isArray(r?.recentGates) ? r.recentGates : Array.isArray(r?.gates) ? r.gates : [];

  return (
    <Box flexDirection="column">
      <Panel title="RISK ENGINE">
        <KV k="Health" v={r?.ok === false ? <Badge tone="err">FAULT</Badge> : r ? <Badge tone="ok">OK</Badge> : <Text color={theme.dim}>…</Text>} />
        <KV k="Daily loss" v={r?.dailyLoss != null ? <Text>{String(r.dailyLoss)}</Text> : <Text color={theme.dim}>—</Text>} />
        <KV k="Drawdown" v={r?.drawdown != null ? <Text>{String(r.drawdown)}</Text> : <Text color={theme.dim}>—</Text>} />
        <KV k="Buying power" v={r?.buyingPower != null ? <Text>{String(r.buyingPower)}</Text> : <Text color={theme.dim}>—</Text>} />
        {risk.error && <Text color={theme.err}>{risk.error}</Text>}
      </Panel>
      <Panel title={`RECENT GATES${gates.length ? ` (${gates.length})` : ''}`}>
        <DataTable
          columns={[{ header: 'Gate', width: 30 }, { header: 'Result', width: 12 }, { header: 'Detail', width: 38 }]}
          emptyText={risk.data ? '(no gate evaluations reported)' : '(loading…)'}
          rows={gates.slice(0, 15).map((g) => [
            <Text>{String(g.name ?? g.gate ?? '?')}</Text>,
            /pass|ok|allow/i.test(String(g.result ?? g.status ?? '')) ? <Badge tone="ok">PASS</Badge> : <Badge tone="err">BLOCK</Badge>,
            <Text wrap="truncate">{String(g.detail ?? g.reason ?? '—')}</Text>,
          ])}
        />
        <Text color={theme.dim}>Read-only. RiskEngine gates cannot be changed from the TUI.</Text>
      </Panel>
    </Box>
  );
}
