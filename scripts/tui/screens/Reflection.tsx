/**
 * Daily reflection screen (workstream J, 2026-10-06): read-only post-market
 * reflection for the most recent completed session.
 *
 * Shows the discovery coverage funnel (movers → seen → evaluated → acted),
 * the top movers table with Argus's fate per symbol, never-seen blind spots,
 * repeating issues, and a symbol drill-down (fate, secondary reasons,
 * outcome windows, premarket_known_by). Honest empty states when the date
 * has no reflection data — never fabricates.
 *
 * Presentation layer only: all data comes from the TUI HTTP client
 * (GET /api/v2/observability/daily-reflection/latest). Keys: ↑/↓ select a
 * mover, Enter drill down, Esc back.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, DataTable, KV, Badge } from '../components.js';
import { theme } from '../theme.js';

type FateTone = 'ok' | 'warn' | 'err' | 'info' | 'dim';

function fateTone(fate: string): FateTone {
  switch (fate) {
    case 'ACTED_ON': return 'ok';
    case 'APPROVED_NOT_EXECUTED': return 'info';
    case 'CONSENSUS_REJECTED':
    case 'RISK_REJECTED': return 'warn';
    case 'NEVER_SEEN': return 'err';
    default: return 'dim';
  }
}

function fmtPct(v: unknown): string {
  const n = typeof v === 'number' ? v : null;
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtRate(v: unknown): string {
  const n = typeof v === 'number' ? v : null;
  return n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`;
}

export function ReflectionScreen({ client, refreshTick, compact }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const res = usePoll(client, (c) => c.dailyReflection('latest'), 30000, refreshTick);
  const report: any = res.data?.report ?? null;
  const movers: any[] = Array.isArray(report?.movers) ? report.movers : [];
  const details: Record<string, any> = report?.moverDetails && typeof report.moverDetails === 'object' ? report.moverDetails : {};

  const [sel, setSel] = useState(0);
  const [drill, setDrill] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.upArrow) { setSel((s) => Math.max(0, s - 1)); setDrill(null); }
    else if (key.downArrow) { setSel((s) => Math.min(Math.max(0, movers.length - 1), s + 1)); }
    else if (key.return) { const m = movers[sel]; if (m) setDrill(String(m.symbol)); }
    else if (key.escape) { setDrill(null); }
  });

  const drillDetail: any = drill ? details[drill] : null;

  return (
    <Box flexDirection="column">
      <Panel title={`DAILY REFLECTION${report?.tradingDate ? ` — ${report.tradingDate}` : ''}`}>
        {res.error && <Text color={theme.err}>{res.error}</Text>}
        {!res.data && !res.error && <Text color={theme.dim}>(loading…)</Text>}
        {report && !report.hasData && (
          <Box flexDirection="column">
            <Text color={theme.warn}>No reflection data for {report.tradingDate ?? 'this date'} yet.</Text>
            <Text color={theme.dim}>
              {`mover_coverage: ${report.sources?.moverCoverageTablePresent ? `${report.sources?.moverCoverageRows ?? 0} rows` : 'table not present yet'} · `}
              {`session metrics: ${report.sources?.sessionMetrics ? 'present' : 'absent'} · `}
              {`focus report: ${report.sources?.premarketFocus ? 'present' : 'absent'} · `}
              {`post-market: ${report.sources?.postmarket ? 'present' : 'absent'}`}
            </Text>
            <Text color={theme.dim}>The TUI never fabricates reflection data.</Text>
          </Box>
        )}
        {report && report.hasData && (() => {
          const f = report.discoveryCoverage?.funnel ?? {};
          const rates = report.discoveryCoverage?.sessionMetricsRates ?? {};
          return (
            <Box flexDirection="column">
              <KV k="Coverage funnel" v={
                <Text>movers <Text bold>{f.movers ?? '—'}</Text> → seen <Text bold>{f.seen ?? '—'}</Text> → evaluated <Text bold>{f.evaluated ?? '—'}</Text> → acted <Text bold>{f.acted ?? '—'}</Text></Text>
              } />
              <KV k="Never-seen" v={<Text>{report.neverSeenMovers?.length ?? 0} blind spots</Text>} />
              <KV k="Filtered" v={<Text>{report.filteredWinnersLosers?.filteredCount ?? 0} (premise wrong: {report.filteredWinnersLosers?.premiseWrong ?? 0})</Text>} />
              <KV k="Session rates" v={
                <Text color={theme.dim}>
                  {`recall ${fmtRate(rates.focusRecall)} · never-seen ${fmtRate(rates.neverSeenRate)} · eval ${fmtRate(rates.evaluationRate)} · consensus ${fmtRate(rates.consensusApprovalRate)}`}
                </Text>
              } />
            </Box>
          );
        })()}
      </Panel>

      {report && report.hasData && !drillDetail && (
        <Box flexDirection="column" marginTop={1}>
          <Panel title={`TOP MOVERS — ARGUS FATE PER SYMBOL (${movers.length})`}>
            <DataTable
              columns={[
                { header: 'SYMBOL', width: 10 },
                { header: 'MOVE', width: 10 },
                { header: 'FATE', width: compact ? 22 : 28 },
              ]}
              emptyText="(no movers recorded)"
              rows={movers.slice(0, 15).map((m, i) => {
                const selected = i === sel;
                const fate = String(m.primaryFate ?? '?');
                return [
                  selected ? <Text bold color={theme.info}>▶ {String(m.symbol)}</Text> : <Text>{String(m.symbol)}</Text>,
                  <Text>{fmtPct(m.eodMovePct)}</Text>,
                  <Badge tone={fateTone(fate)}>{fate}</Badge>,
                ];
              })}
            />
            <Text color={theme.dim}>↑/↓ select · Enter drill-down · Esc back</Text>
          </Panel>

          <Box marginTop={1}>
            <Panel title={`BLIND SPOTS — NEVER SEEN (${(report.neverSeenMovers ?? []).length})`}>
              {(report.neverSeenMovers ?? []).length === 0 ? (
                <Text color={theme.dim}>(every mover was seen by discovery)</Text>
              ) : (
                <Box flexDirection="column">
                  {(report.neverSeenMovers ?? []).slice(0, 8).map((m: any) => (
                    <Text key={m.symbol}>
                      <Text bold>{String(m.symbol)}</Text>
                      <Text> {fmtPct(m.eodMovePct)}  </Text>
                      <Text color={theme.dim}>{String(m.cause ?? 'cause not recorded')}</Text>
                    </Text>
                  ))}
                </Box>
              )}
            </Panel>
          </Box>

          {(report.repeatingIssues ?? []).length > 0 && (
            <Box marginTop={1}>
              <Panel title="REPEATING ISSUES">
                <Box flexDirection="column">
                  {(report.repeatingIssues ?? []).map((issue: string, i: number) => (
                    <Text key={i} color={theme.warn}>• {issue}</Text>
                  ))}
                </Box>
              </Panel>
            </Box>
          )}
        </Box>
      )}

      {drillDetail && (
        <Box marginTop={1}>
          <Panel title={`DRILL-DOWN — ${drillDetail.symbol}`}>
            <KV k="EOD move" v={<Text bold>{fmtPct(drillDetail.eodMovePct)}</Text>} />
            <KV k="Fate" v={<Badge tone={fateTone(String(drillDetail.primaryFate))}>{String(drillDetail.primaryFate)}</Badge>} />
            <KV k="Reference price" v={<Text>{drillDetail.referencePrice ?? '—'}</Text>} />
            {drillDetail.filterReason && (
              <KV k="Filter" v={<Text>{`${drillDetail.filterReason} (premise ${drillDetail.filterPremiseCorrect == null ? 'unevaluated' : drillDetail.filterPremiseCorrect ? 'held' : 'wrong'})`}</Text>} />
            )}
            {drillDetail.neverSeenCause && (
              <KV k="Never-seen cause" v={<Text color={theme.err}>{String(drillDetail.neverSeenCause)}</Text>} />
            )}
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.bright} bold>Secondary reasons</Text>
              {(drillDetail.secondaryReasons ?? []).length === 0
                ? <Text color={theme.dim}>(none recorded)</Text>
                : (drillDetail.secondaryReasons ?? []).map((r: string, i: number) => <Text key={i}>• {r}</Text>)}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.bright} bold>Outcome windows</Text>
              {(drillDetail.outcomeWindows ?? []).length === 0
                ? <Text color={theme.dim}>(none recorded)</Text>
                : (drillDetail.outcomeWindows ?? []).map((w: any, i: number) => (
                  <Text key={i}>• {String(w.window)}: {fmtPct(w.returnPct)}{w.note ? ` — ${w.note}` : ''}</Text>
                ))}
            </Box>
            <Box marginTop={1}>
              <KV k="Premarket known by" v={
                <Text>{(drillDetail.premarketKnownBy ?? []).length > 0 ? drillDetail.premarketKnownBy.join(', ') : '—'}</Text>
              } />
            </Box>
            <Text color={theme.dim}>Esc back to the movers table</Text>
          </Panel>
        </Box>
      )}
    </Box>
  );
}
