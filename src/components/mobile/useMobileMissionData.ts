import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../../lib/clientFetch';
import { useWebSocket } from '../../context/WebSocketContext';
import riskGateOrder from '../../../config/riskGateOrder.json';
import tradingSafety from '../../../config/tradingSafety.json';
import eventCatalog from '../../../config/eventNames.json';
import {
  mergeMobileMissionSnapshot,
  patchMobileMissionSnapshot,
  type MobileAgentVote,
  type MobileGateRow,
  type MobileLogEvent,
  type MobileMissionSnapshot,
} from './mobileMissionStore';
import { CONSENSUS_APPROVAL_THRESHOLD } from '../agentFocus/displayConsensus';

const LOG_CAP = 50;
const POLL_CONNECTED_MS = 30_000;
const POLL_DISCONNECTED_MS = 5_000;
const WS_SNAPSHOT = 'INITIAL_STATE_SNAPSHOT';

async function fetchJson(url: string): Promise<{
  ok: boolean;
  data: any;
  error?: string;
  status?: number;
  unauthorized?: boolean;
}> {
  const res = await apiFetch(url);
  return {
    ok: res.ok,
    data: res.data,
    error: res.error,
    status: res.status,
    unauthorized: res.unauthorized,
  };
}

/** Hydrate mobile store from server INITIAL_STATE_SNAPSHOT (WebSocket on connect). */
export function applyInitialStateSnapshot(data: Record<string, unknown> | null | undefined): void {
  if (!data) return;
  const pf = data.portfolio as Record<string, unknown> | undefined;
  const st = data.settings as Record<string, unknown> | undefined;
  const autobot = data.autobot as Record<string, unknown> | undefined;
  const schedule = autobot?.scheduleWindow as Record<string, unknown> | undefined;
  const consensus = data.consensus as Record<string, unknown> | undefined;
  const tradingState = String(st?.trading_state ?? 'TRADING_ENABLED');
  const emergency = autobot?.emergencyStopActive === true
    || tradingState === 'EMERGENCY_STOP'
    || tradingState === 'TRADING_PAUSED';

  patchMobileMissionSnapshot({
    portfolio: pf?.available === false ? null : {
      equity: (pf?.equity as number) ?? null,
      cash: (pf?.cash as number) ?? null,
      drawdown: (pf?.drawdownPct as number) ?? null,
      peakValuation: (pf?.peakValuation as number) ?? null,
      positions: Array.isArray(pf?.positions)
        ? pf.positions as NonNullable<MobileMissionSnapshot['portfolio']>['positions']
        : [],
    },
    settings: {
      maxPortfolioDrawdownPct: (st?.maxPortfolioDrawdownPct as number) ?? 0.15,
      budget: (pf?.budget as number) ?? null,
    },
    tradingMode: String(st?.trading_mode ?? 'PAPER'),
    tradingState,
    autobotEnabled: st?.auto_bot_enabled === true || st?.auto_bot_enabled === 1,
    emergencyStopActive: emergency,
    marketSession: String(schedule?.sessionLabel ?? 'UNKNOWN'),
    consensus: {
      side: (consensus?.side as string) ?? null,
      weightedConfidence: (consensus?.weightedConfidence as number) ?? null,
      threshold: (consensus?.threshold as number) ?? CONSENSUS_APPROVAL_THRESHOLD,
      approved: (consensus?.approved as boolean | null | undefined) ?? null,
      agentVotes: [],
      noConsensus: false,
    },
    ...(pf?.intradayPl != null ? {
      capital: {
        argusAllocated: (pf?.budget as number) ?? null,
        argusUsed: null,
        argusRemaining: null,
        openOrders: null,
        dailyPnl: (pf?.intradayPl as number) ?? null,
        unrealizedPnl: null,
      },
    } : {}),
    lastRefreshAt: Date.now(),
    sessionExpired: false,
  });
}

function buildGateLadder(
  liveGates: Map<string, boolean>,
  persisted: Array<{ gateName: string; passed: boolean; detail?: unknown }> | undefined,
): { gates: MobileGateRow[]; summary: { passed: number; failed: number; unknown: number } } {
  const byName = new Map<string, MobileGateRow>();
  for (const g of persisted || []) {
    byName.set(g.gateName, {
      name: g.gateName,
      passed: g.passed,
      detail: typeof g.detail === 'string' ? g.detail : g.detail ? JSON.stringify(g.detail) : null,
      source: 'persisted',
    });
  }
  for (const [name, passed] of liveGates) {
    byName.set(name, { name, passed, source: 'live' });
  }
  const extra = [...byName.keys()].filter((k) => !riskGateOrder.gates.includes(k));
  const ladder = [...riskGateOrder.gates, ...extra];
  const gates = ladder.map((name) => byName.get(name) || { name, passed: null, source: 'persisted' as const });
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  for (const g of gates) {
    if (g.passed === true) passed += 1;
    else if (g.passed === false) failed += 1;
    else unknown += 1;
  }
  return { gates, summary: { passed, failed, unknown } };
}

function pushLogEvent(prev: MobileLogEvent[], evt: MobileLogEvent): MobileLogEvent[] {
  const next = [evt, ...prev.filter((e) => e.id !== evt.id)];
  return next.slice(0, LOG_CAP);
}

export function useMobileMissionData(enabled: boolean) {
  const { subscribe, status, latencyMs, forceReconnect } = useWebSocket();
  const liveGatesRef = useRef(new Map<string, boolean>());
  const refreshLock = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || refreshLock.current) return;
    refreshLock.current = true;
    patchMobileMissionSnapshot({ refreshing: true, sessionExpired: false });

    const errors: Record<string, string> = {};
    let sessionExpired = false;

    try {
      const [
        portfolioRes,
        autobotRes,
        settingsRes,
        capitalRes,
        missionRes,
        diagRes,
        txRes,
        tradesRes,
        organicRes,
        eventsRes,
        healthRes,
      ] = await Promise.all([
        fetchJson('/api/v1/portfolio'),
        fetchJson('/api/v1/autobot'),
        fetchJson('/api/v1/config/settings'),
        fetchJson('/api/v2/orchestration/capital'),
        fetchJson('/api/v2/system/mission-control'),
        fetchJson('/api/v2/diagnostics'),
        fetchJson('/api/v2/transactions?limit=25'),
        fetchJson('/api/v1/trades'),
        fetchJson('/api/v2/research/organic-paper'),
        fetchJson('/api/v2/system/events'),
        fetchJson('/api/v2/system/startup-health'),
      ]);

      for (const r of [portfolioRes, autobotRes, settingsRes, capitalRes, missionRes, diagRes, txRes, tradesRes, organicRes, eventsRes, healthRes]) {
        if (r.unauthorized) sessionExpired = true;
      }

      if (!portfolioRes.ok) errors.portfolio = portfolioRes.error || 'portfolio failed';
      if (!autobotRes.ok) errors.autobot = autobotRes.error || 'autobot failed';
      if (!settingsRes.ok) errors.settings = settingsRes.error || 'settings failed';
      if (!capitalRes.ok) errors.capital = capitalRes.error || 'capital failed';
      if (!missionRes.ok) errors.missionControl = missionRes.error || 'mission-control failed';
      if (!diagRes.ok) errors.diagnostics = diagRes.error || 'diagnostics failed';
      if (!txRes.ok) errors.transactions = txRes.error || 'transactions failed';
      if (!tradesRes.ok) errors.trades = tradesRes.error || 'trades failed';
      if (!organicRes.ok) errors.organic = organicRes.error || 'organic-paper failed';
      if (!eventsRes.ok) errors.events = eventsRes.error || 'events failed';
      if (!healthRes.ok) errors.startupHealth = healthRes.error || 'startup-health failed';

      const pf = portfolioRes.ok ? portfolioRes.data : null;
      const autobot = autobotRes.ok ? autobotRes.data : null;
      const settings = settingsRes.ok ? settingsRes.data : null;
      const capital = capitalRes.ok ? capitalRes.data : null;
      const transactions = txRes.ok && Array.isArray(txRes.data?.transactions) ? txRes.data.transactions : [];
      const closedTrades = tradesRes.ok && Array.isArray(tradesRes.data)
        ? tradesRes.data.filter((t: any) => t.status === 'FILLED' || t.side === 'SELL')
        : tradesRes.ok && Array.isArray(tradesRes.data?.trades)
          ? tradesRes.data.trades
          : [];

      let marketSession = organicRes.ok ? (organicRes.data?.marketSession || 'UNKNOWN') : 'UNKNOWN';
      const schedule = autobot?.scheduleWindow;
      if (schedule?.sessionLabel) marketSession = schedule.sessionLabel;
      else if (schedule?.inWindow === false && marketSession === 'UNKNOWN') marketSession = 'CLOSED';

      const latestTx = transactions[0];
      let latestTxDetail: Record<string, unknown> | null = null;
      let quant: Record<string, unknown> | null = null;
      let agentVotes: MobileAgentVote[] = [];
      let consensusSide: string | null = latestTx?.proposedSide ?? null;
      let weightedConfidence: number | null = latestTx?.weightedConfidence ?? null;
      let threshold: number | null = latestTx?.consensusThreshold ?? CONSENSUS_APPROVAL_THRESHOLD;
      let noConsensus = latestTx?.finalDecision == null && latestTx?.status === 'NO_CONSENSUS';

      if (latestTx?.id) {
        const detailRes = await fetchJson(`/api/v2/transactions/${encodeURIComponent(latestTx.id)}`);
        if (detailRes.unauthorized) sessionExpired = true;
        if (detailRes.ok && detailRes.data?.ok !== false) {
          latestTxDetail = detailRes.data;
          const cd = detailRes.data.consensusDecision;
          const evidence = detailRes.data.evidence as Array<any> | undefined;
          if (cd) {
            consensusSide = cd.side ?? consensusSide;
            weightedConfidence = cd.weightedConfidence ?? weightedConfidence;
            threshold = cd.threshold ?? threshold;
          }
          if (Array.isArray(evidence)) {
            agentVotes = evidence.map((e) => ({
              agent: e.agent,
              side: e.side,
              confidence: e.confidence,
              weight: e.weight,
              agreed: e.agreed,
            }));
          }
          quant = detailRes.data.quantAssessment ?? null;
          const persistedGates = detailRes.data.riskGates as Array<any> | undefined;
          const { gates, summary } = buildGateLadder(liveGatesRef.current, persistedGates?.map((g) => ({
            gateName: g.gateName,
            passed: g.passed,
            detail: g.detail,
          })));
          patchMobileMissionSnapshot({ gates, gateSummary: summary });
        }
      }

      const eventsRaw = eventsRes.ok && Array.isArray(eventsRes.data?.events) ? eventsRes.data.events : [];
      const logEvents: MobileLogEvent[] = eventsRaw.slice(-LOG_CAP).reverse().map((e: any, i: number) => ({
        id: e.eventId || `${e.type}-${e.timestamp}-${i}`,
        type: e.type,
        timestamp: typeof e.timestamp === 'number' ? e.timestamp : new Date(e.timestamp).getTime(),
        source: e.source,
        payload: e.payload,
      }));

      const { gates, summary } = buildGateLadder(liveGatesRef.current, undefined);
      const tradingState = autobot?.tradingState ?? settings?.tradingState ?? 'TRADING_ENABLED';

      patchMobileMissionSnapshot({
        refreshing: false,
        lastRefreshAt: Date.now(),
        sessionExpired,
        tradingMode: autobot?.tradingMode || settings?.tradingMode || 'PAPER',
        tradingState,
        marketSession,
        autobotEnabled: autobot?.enabled === true || autobot?.autoBotEnabled === true,
        emergencyStopActive: autobot?.emergencyStopActive === true || tradingState !== 'TRADING_ENABLED',
        portfolio: pf?.available === false ? null : {
          equity: pf?.equity ?? null,
          cash: pf?.cash ?? null,
          drawdown: pf?.drawdown ?? null,
          peakValuation: pf?.peakValuation ?? null,
          positions: Array.isArray(pf?.positions) ? pf.positions : [],
        },
        capital: capital?.ok ? {
          argusAllocated: capital.argus?.allocated ?? null,
          argusUsed: capital.argus?.used ?? null,
          argusRemaining: capital.argus?.remaining ?? null,
          openOrders: capital.broker?.openOrders ?? null,
          dailyPnl: capital.broker?.dailyPnl ?? null,
          unrealizedPnl: capital.broker?.unrealizedPnl ?? null,
        } : null,
        settings: settings ? {
          maxPortfolioDrawdownPct: settings.maxPortfolioDrawdownPct ?? settings.max_portfolio_drawdown_pct ?? 0.15,
          budget: settings.budget ?? autobot?.budget ?? null,
        } : {
          maxPortfolioDrawdownPct: 0.15,
          budget: autobot?.budget ?? null,
        },
        missionControl: missionRes.ok ? missionRes.data : null,
        latestTxId: latestTx?.id ?? null,
        latestTxDetail,
        transactions,
        closedTrades: Array.isArray(closedTrades) ? closedTrades.slice(0, 20) : [],
        consensus: {
          side: consensusSide,
          weightedConfidence,
          threshold,
          approved: latestTx?.finalDecision === 'APPROVED' ? true : latestTx?.finalDecision === 'REJECTED' ? false : null,
          agentVotes,
          noConsensus,
        },
        quant,
        gates,
        gateSummary: summary,
        dailyLimits: {
          currentDailyLoss: autobot?.currentDailyLoss ?? null,
          dailyLossLimit: autobot?.dailyLossLimit ?? null,
          dailyBuyNotional: null,
          maxDailyBuyNotional: tradingSafety.maxDailyBuyNotionalDollars,
        },
        diagnostics: diagRes.ok && Array.isArray(diagRes.data?.diagnostics) ? diagRes.data.diagnostics : [],
        startupHealth: healthRes.ok && Array.isArray(healthRes.data?.services) ? healthRes.data.services : [],
        logEvents,
        errors,
        equityHistory: Array.isArray(autobot?.equityHistory) ? autobot.equityHistory : [],
        organicPaper: organicRes.ok ? {
          closedTradeCount: organicRes.data?.closedTradeCount ?? null,
          sessionCount: organicRes.data?.sessionCount ?? null,
          minPaperTrades: organicRes.data?.minPaperTrades ?? 30,
          minPaperSessions: organicRes.data?.minPaperSessions ?? 10,
          soakStatus: organicRes.data?.soak?.status ?? organicRes.data?.soak?.legacyStatus ?? null,
        } : null,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'refresh failed';
      patchMobileMissionSnapshot({
        refreshing: false,
        errors: { refresh: message },
      });
    } finally {
      refreshLock.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    patchMobileMissionSnapshot({ wsStatus: status, wsLatencyMs: latencyMs });
  }, [status, latencyMs]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const ms = status === 'connected' ? POLL_CONNECTED_MS : POLL_DISCONNECTED_MS;
    const interval = setInterval(refresh, ms);
    return () => clearInterval(interval);
  }, [enabled, refresh, status]);

  useEffect(() => {
    if (!enabled) return;

    const onGate = (data: any) => {
      const name = data?.gateName || data?.gate;
      if (!name) return;
      liveGatesRef.current.set(name, data?.passed === true);
      mergeMobileMissionSnapshot((prev) => {
        const { gates, summary } = buildGateLadder(
          liveGatesRef.current,
          prev.latestTxDetail?.riskGates as any,
        );
        return { gates, gateSummary: summary };
      });
    };

    const onConsensus = (data: any) => {
      mergeMobileMissionSnapshot((prev) => ({
        consensus: {
          ...prev.consensus,
          side: data?.side ?? prev.consensus.side,
          weightedConfidence: data?.weightedConfidence ?? prev.consensus.weightedConfidence,
          threshold: data?.threshold ?? prev.consensus.threshold,
          approved: data?.approved ?? prev.consensus.approved,
          noConsensus: data?.approved === false,
        },
      }));
    };

    const onAutobot = (data: any) => {
      patchMobileMissionSnapshot({
        autobotEnabled: data?.enabled === true || data?.autoBotEnabled === true,
        emergencyStopActive: data?.emergencyStopActive === true,
      });
    };

    const onBusEvent = (type: string) => (payload: any) => {
      const evt: MobileLogEvent = {
        id: payload?.eventId || `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        timestamp: Date.now(),
        source: payload?.agent || payload?.source,
        payload,
      };
      mergeMobileMissionSnapshot((prev) => ({
        logEvents: pushLogEvent(prev.logEvents, evt),
      }));
    };

    const onTradingState = (data: any) => {
      const toState = data?.toState ?? data?.tradingState;
      if (!toState) return;
      const halted = toState === 'EMERGENCY_STOP' || toState === 'TRADING_PAUSED';
      patchMobileMissionSnapshot({
        tradingState: toState,
        emergencyStopActive: halted,
        ...(halted ? { autobotEnabled: false } : {}),
        actionBanner: halted
          ? { tone: 'danger', message: 'EMERGENCY HALT ACTIVE — Trading Paused' }
          : null,
      });
    };

    const onInitialSnapshot = (data: any) => {
      applyInitialStateSnapshot(data);
    };

    const unsubs = [
      subscribe(WS_SNAPSHOT, onInitialSnapshot),
      subscribe(eventCatalog.TRADING_STATE_CHANGED || 'TRADING_STATE_CHANGED', onTradingState),
      subscribe('KILL_SWITCH_TRIGGERED', onTradingState),
      subscribe(eventCatalog.RISK_GATE_EVALUATED || 'RISK_GATE_EVALUATED', onGate),
      subscribe(eventCatalog.CHIEF_CONSENSUS_COMPLETED || 'CHIEF_CONSENSUS_COMPLETED', onConsensus),
      subscribe('AUTOBOT_STATE_UPDATED', onAutobot),
      subscribe('TRADE_IDEA_GENERATED', onBusEvent('TRADE_IDEA_GENERATED')),
      subscribe('ORDER_EXECUTED', onBusEvent('ORDER_EXECUTED')),
      subscribe('RISK_ASSESSMENT_COMPLETED', onBusEvent('RISK_ASSESSMENT_COMPLETED')),
    ];

    return () => unsubs.forEach((u) => u());
  }, [enabled, subscribe]);

  const pullToRefresh = useCallback(async () => {
    forceReconnect();
    await refresh();
  }, [forceReconnect, refresh]);

  return { refresh, pullToRefresh };
}

export async function toggleAutobotRemote(currentEnabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch('/api/v1/autobot/toggle', {
    method: 'POST',
    body: JSON.stringify({ enabled: !currentEnabled }),
  });
  if (res.unauthorized) {
    patchMobileMissionSnapshot({ sessionExpired: true, actionBanner: { tone: 'error', message: 'Session expired — please log in again.' } });
    return { ok: false, error: res.error || 'Session expired' };
  }
  if (!res.ok) {
    patchMobileMissionSnapshot({ actionBanner: { tone: 'error', message: res.error || 'Autobot toggle failed' } });
    return { ok: false, error: res.error || `HTTP ${res.status}` };
  }
  const data = res.data as Record<string, unknown>;
  const state = data.state as Record<string, unknown> | undefined;
  const enabled = state?.enabled === true || data.enabled === true;
  patchMobileMissionSnapshot({
    autobotEnabled: enabled,
    actionBanner: { tone: 'success', message: enabled ? 'Autobot enabled' : 'Autobot disabled' },
  });
  return { ok: true };
}

export async function triggerEmergencyStop(): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch('/api/v1/system/emergency-stop', { method: 'POST' });
  if (res.unauthorized) {
    patchMobileMissionSnapshot({ sessionExpired: true, actionBanner: { tone: 'error', message: 'Session expired — please log in again.' } });
    return { ok: false, error: res.error || 'Session expired' };
  }
  if (!res.ok) {
    patchMobileMissionSnapshot({ actionBanner: { tone: 'error', message: res.error || 'Emergency stop failed' } });
    return { ok: false, error: res.error || `HTTP ${res.status}` };
  }
  const data = res.data as Record<string, unknown>;
  const tradingState = String(data.tradingState ?? 'EMERGENCY_STOP');
  patchMobileMissionSnapshot({
    emergencyStopActive: true,
    autobotEnabled: false,
    tradingState,
    actionBanner: { tone: 'danger', message: 'EMERGENCY HALT ACTIVE — Trading Paused' },
  });
  return { ok: true };
}
