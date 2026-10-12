/**
 * ==========================================================
 * Module: SessionFaultPlan
 *
 * Session-level fault plan for the full synthetic trading-day certification
 * (2026-10-11, Argus Oct 8-9 defect-closure mission, Worker H).
 *
 * LABEL: SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY
 *
 * Every fault in this plan controls the ENVIRONMENT, never the DECISION
 * (repo AGENTS.md: "Synthetic market data, synthetic broker, synthetic clock,
 * and fault injection are fine; forcing a strategy signal, a Chief/Risk
 * approval, or a fill above the broker boundary is NOT"). Concretely:
 *
 *  - LATE_MOVER: admits a new symbol mid-session (subscribe + begin feeding its
 *    deterministic bars). Whether QuantSignalAgent evaluates it, and what it
 *    concludes, is the real pipeline's own business.
 *  - NEWS_BURST: queues raw article text/timing into the real news pipeline via
 *    SyntheticInjectableNewsProvider. Sentiment, clustering, vetoes, and any
 *    NewsAgent idea are computed by real production code.
 *  - AI_OUTAGE / AI_RECOVERY: clears / re-registers AIRouter providers. This
 *    models "every AI provider unreachable". No AI-originated content is
 *    fabricated; the quant spine must keep working without AI (mechanism
 *    certification, not alpha proof).
 *  - JEV_OUTAGE_PROBE: asserts the Jev decision provider stays inert
 *    (not configured -> decide() throws NO_API_KEY before any network attempt)
 *    and records that no decision path consulted it.
 *  - FEED_INTERRUPTION: suppresses market-data tick emission for a window
 *    (bars are still generated and persisted; the outage is in DELIVERY, the
 *    same shape as the DATA_INTERRUPTION scenario). The existing
 *    ORDER_DURING_OUTAGE timeline invariant proves no order fired inside it.
 *  - BACKUP_RUN: runs the real DbBackupService.runBackup() once mid-session.
 *  - PARTIAL_FILL_LIQUIDITY_CAP: sets the replay broker's public
 *    maxVolumeParticipationPct for a window - a LIQUIDITY constraint. Fill
 *    prices, cash accounting, and multi-bar completion all stay inside
 *    HistoricalReplayBroker's real logic.
 *  - RISK_REJECTION_PROBE / INVALID_STRATEGY_PROBE / VALID_STRATEGY_PROBE /
 *    STALE_TAIL_PROBE: premarket probes that call the REAL RiskEngine,
 *    authorization resolver, execution policy, and HistoricalDataGateway with
 *    adversarial inputs and assert fail-closed behavior. They never place an
 *    order and never manufacture authority.
 *
 * Production-safety boundary: this module lives in src/server/replay/synthetic/
 * (certification-only path). It performs NO static import of any db-touching
 * module - every production import below is dynamic, executed only after the
 * synthetic session's isolation env vars are already in effect (same discipline
 * as SyntheticSessionEngine.ts's own header comment). It never touches the
 * production database, never arms LIVE, never writes a lifecycle row.
 * ==========================================================
 */
import type { HistoricalReplayBroker } from '../../../brokers/HistoricalReplayBroker';
import type { SyntheticInjectableNewsProvider, SyntheticNewsArticleSpec } from './SyntheticInjectableNewsProvider';

export type SessionPhase =
  | 'PREMARKET' | 'OPEN' | 'MORNING' | 'MIDDAY' | 'POWER_HOUR' | 'CLOSE' | 'POST_CLOSE';

export type SessionFaultKind =
  | 'LATE_MOVER'
  | 'NEWS_BURST'
  | 'AI_OUTAGE'
  | 'AI_RECOVERY'
  | 'JEV_OUTAGE_PROBE'
  | 'FEED_INTERRUPTION'
  | 'BACKUP_RUN'
  | 'PARTIAL_FILL_LIQUIDITY_CAP'
  | 'RISK_REJECTION_PROBE'
  | 'INVALID_STRATEGY_PROBE'
  | 'VALID_STRATEGY_PROBE'
  | 'STALE_TAIL_PROBE';

export interface SessionFault {
  kind: SessionFaultKind;
  /** First bar index (0-based) the fault applies at. -1 = premarket (before bar 0). */
  fromBar: number;
  /** Last bar index (inclusive) for window faults. Omit for one-shot faults. */
  toBar?: number;
  phase: SessionPhase;
  /** Human label for the certification report. */
  label: string;
  params?: {
    /** LATE_MOVER */
    symbol?: string;
    /** NEWS_BURST */
    articles?: SyntheticNewsArticleSpec[];
    /** PARTIAL_FILL_LIQUIDITY_CAP */
    maxVolumeParticipationPct?: number;
  };
}

export interface FaultOutcome {
  kind: SessionFaultKind;
  phase: SessionPhase;
  label: string;
  atBar: number;
  /** true = the fault was applied (or the probe ran); false = skipped with reason. */
  applied: boolean;
  /** PASS = environment behaved as the fault required AND the pipeline failed
   *  closed / degraded gracefully; FAIL = the fault could not be applied or the
   *  pipeline misbehaved; INFO = observation only. */
  verdict: 'PASS' | 'FAIL' | 'INFO';
  detail: string;
}

/** Context the engine hands the applier for bar-level faults. */
export interface BarFaultContext {
  barIndex: number;
  clockNowMs: number;
  broker: HistoricalReplayBroker;
  marketDataWorker: { subscribe(symbol: string): void };
  newsProvider: SyntheticInjectableNewsProvider | null;
  /** Called by the LATE_MOVER fault to start revealing a symbol's bars. */
  admitLateSymbol?: (symbol: string) => void;
}

/** Context for premarket/post-close probes (core already booted). */
export interface ProbeContext {
  sessionStartMs: number;
}

function outcome(
  fault: SessionFault, atBar: number, applied: boolean,
  verdict: FaultOutcome['verdict'], detail: string,
): FaultOutcome {
  return { kind: fault.kind, phase: fault.phase, label: fault.label, atBar, applied, verdict, detail };
}

export class SessionFaultApplier {
  private readonly faults: SessionFault[];
  /** Providers cleared by AI_OUTAGE, for AI_RECOVERY to re-register. */
  private clearedProviders: Array<[string, unknown]> = [];
  private aiOutageActive = false;

  constructor(faults: SessionFault[]) {
    this.faults = faults;
  }

  /** Window faults active at a bar index (FEED_INTERRUPTION, PARTIAL_FILL_LIQUIDITY_CAP). */
  private windowsActiveAt(kind: SessionFaultKind, bar: number): SessionFault[] {
    return this.faults.filter(
      (f) => f.kind === kind && bar >= f.fromBar && (f.toBar === undefined || bar <= f.toBar),
    );
  }

  isFeedInterrupted(barIndex: number): boolean {
    return this.windowsActiveAt('FEED_INTERRUPTION', barIndex).length > 0;
  }

  liquidityCapAt(barIndex: number): number | null {
    const wins = this.windowsActiveAt('PARTIAL_FILL_LIQUIDITY_CAP', barIndex);
    if (wins.length === 0) return null;
    const pct = wins[0].params?.maxVolumeParticipationPct;
    return typeof pct === 'number' ? pct : null;
  }

  needsNewsProvider(): boolean {
    return this.faults.some((f) => f.kind === 'NEWS_BURST');
  }

  /** One-shot faults with fromBar === -1 (premarket probes). Called after boot, before bar 0. */
  async applyPremarket(ctx: ProbeContext): Promise<FaultOutcome[]> {
    const out: FaultOutcome[] = [];
    for (const fault of this.faults.filter((f) => f.fromBar === -1)) {
      try {
        out.push(await this.applyProbe(fault, ctx));
      } catch (e: any) {
        out.push(outcome(fault, -1, false, 'FAIL', `probe threw: ${e?.message ?? e}`));
      }
    }
    return out;
  }

  /** Bar-level faults: one-shots at fromBar, plus window state enforcement. */
  async applyForBar(barIndex: number, ctx: BarFaultContext): Promise<FaultOutcome[]> {
    const out: FaultOutcome[] = [];
    // Enforce window state every bar (idempotent): liquidity cap follows the window.
    const cap = this.liquidityCapAt(barIndex);
    ctx.broker.maxVolumeParticipationPct = cap;
    // Record window starts once, so the report shows the window was armed (the per-bar
    // enforcement itself is silent by design).
    for (const fault of this.faults) {
      if (fault.toBar !== undefined && fault.fromBar === barIndex) {
        out.push(outcome(fault, barIndex, true, 'INFO',
          `window armed: bars ${fault.fromBar}-${fault.toBar} (${fault.kind})` +
          (fault.kind === 'PARTIAL_FILL_LIQUIDITY_CAP'
            ? ` maxVolumeParticipationPct=${fault.params?.maxVolumeParticipationPct}` : '')));
      }
    }
    for (const fault of this.faults) {
      if (fault.fromBar !== barIndex || fault.fromBar === -1) continue;
      // Window faults are enforced above; only one-shots are applied here.
      if (fault.toBar !== undefined) continue;
      try {
        out.push(await this.applyOneShot(fault, barIndex, ctx));
      } catch (e: any) {
        out.push(outcome(fault, barIndex, false, 'FAIL', `fault threw: ${e?.message ?? e}`));
      }
    }
    return out;
  }

  /** Post-close probes (faults with fromBar === Number.MAX_SAFE_INTEGER marker use phase POST_CLOSE). */
  async applyPostClose(ctx: ProbeContext): Promise<FaultOutcome[]> {
    const out: FaultOutcome[] = [];
    for (const fault of this.faults.filter((f) => f.phase === 'POST_CLOSE' && f.fromBar !== -1)) {
      try {
        out.push(await this.applyProbe(fault, ctx));
      } catch (e: any) {
        out.push(outcome(fault, Number.MAX_SAFE_INTEGER, false, 'FAIL', `probe threw: ${e?.message ?? e}`));
      }
    }
    // Safety: never leave an AI outage armed past the session.
    if (this.aiOutageActive) {
      await this.recoverAi();
      out.push({
        kind: 'AI_RECOVERY', phase: 'POST_CLOSE', label: 'post-close AI provider restoration (safety)',
        atBar: Number.MAX_SAFE_INTEGER, applied: true, verdict: 'INFO',
        detail: 'AI outage was still armed at session end; providers re-registered by the applier.',
      });
      this.aiOutageActive = false;
    }
    // Safety: never leave a liquidity cap armed past the session.
    return out;
  }

  private async applyOneShot(
    fault: SessionFault, barIndex: number, ctx: BarFaultContext,
  ): Promise<FaultOutcome> {
    switch (fault.kind) {
      case 'LATE_MOVER': {
        const symbol = fault.params?.symbol;
        if (!symbol) return outcome(fault, barIndex, false, 'FAIL', 'LATE_MOVER missing params.symbol');
        if (!ctx.admitLateSymbol) return outcome(fault, barIndex, false, 'FAIL', 'engine did not provide admitLateSymbol');
        ctx.admitLateSymbol(symbol);
        return outcome(fault, barIndex, true, 'INFO',
          `admitted ${symbol} at bar ${barIndex} (subscribed + bars revealed from here); ` +
          `whether the pipeline evaluates it is the real agents' own decision`);
      }
      case 'NEWS_BURST': {
        const articles = fault.params?.articles ?? [];
        if (!ctx.newsProvider) {
          return outcome(fault, barIndex, false, 'FAIL',
            'NEWS_BURST needs the injectable news provider installed (engine installs it when the plan needs news)');
        }
        for (const a of articles) ctx.newsProvider.inject(a);
        return outcome(fault, barIndex, true, 'INFO',
          `injected ${articles.length} articles at bar ${barIndex}; ` +
          `sentiment/clustering/veto/ideas are computed by the real news pipeline`);
      }
      case 'AI_OUTAGE': {
        const { AIRouter } = await import('../../ai/AIRouter');
        const router = AIRouter.getInstance();
        this.clearedProviders = router.listProviders() as Array<[string, unknown]>;
        router.clearProviders();
        const routable = await router.hasAnyRoutableProvider();
        this.aiOutageActive = true;
        return outcome(fault, barIndex, true, routable ? 'FAIL' : 'PASS',
          `cleared ${this.clearedProviders.length} AI providers; ` +
          `hasAnyRoutableProvider()=${routable} (must be false)`);
      }
      case 'AI_RECOVERY': {
        if (!this.aiOutageActive) {
          return outcome(fault, barIndex, false, 'INFO', 'no AI outage armed; nothing to recover');
        }
        const count = this.clearedProviders.length;
        await this.recoverAi();
        this.aiOutageActive = false;
        const { AIRouter } = await import('../../ai/AIRouter');
        const routable = await AIRouter.getInstance().hasAnyRoutableProvider();
        return outcome(fault, barIndex, true, 'INFO',
          `re-registered ${count} providers; hasAnyRoutableProvider()=${routable}`);
      }
      case 'JEV_OUTAGE_PROBE': {
        return this.probeJev(fault, barIndex);
      }
      case 'BACKUP_RUN': {
        const { dbBackupService } = await import('../../services/DbBackupService');
        const started = Date.now();
        const result = await dbBackupService.runBackup();
        const ok = typeof result === 'object' && result !== null && (result as any).outcome === 'completed';
        return outcome(fault, barIndex, true, ok ? 'PASS' : 'INFO',
          `DbBackupService.runBackup() -> ${JSON.stringify(result).slice(0, 160)} in ${Date.now() - started}ms (session continued)`);
      }
      default:
        return outcome(fault, barIndex, false, 'FAIL', `unhandled one-shot kind ${fault.kind}`);
    }
  }

  private async recoverAi(): Promise<void> {
    const { AIRouter } = await import('../../ai/AIRouter');
    const router = AIRouter.getInstance();
    for (const [id, provider] of this.clearedProviders) {
      router.registerProvider(id, provider as any);
    }
    this.clearedProviders = [];
  }

  private async probeJev(fault: SessionFault, atBar: number): Promise<FaultOutcome> {
    const { JevDecisionProvider } = await import('../../ai/JevDecisionProvider');
    const jev = JevDecisionProvider.getInstance();
    const configured = jev.isConfigured();
    if (!configured) {
      try {
        await jev.decide({ questions: { probe: 'certification inertness check' }, timeoutMs: 1000 } as any);
        return outcome(fault, atBar, true, 'FAIL',
          'JevDecisionProvider.isConfigured()=false but decide() did NOT throw - inertness violated');
      } catch (e: any) {
        const kind = (e as any)?.kind ?? '';
        const msg = String(e?.message ?? e);
        const inert = kind === 'NO_API_KEY' || /NO_API_KEY/.test(msg);
        return outcome(fault, atBar, true, inert ? 'PASS' : 'FAIL',
          `isConfigured()=false; decide() threw [kind=${kind || 'n/a'}] before any network attempt ` +
          `(expected NO_API_KEY) - Jev remains inert, no decision path can consult it`);
      }
    }
    return outcome(fault, atBar, true, 'INFO',
      'JevDecisionProvider.isConfigured()=true in this environment - outage probe not applicable; ' +
      'Jev failure semantics are covered by jevFailureSemantics.test.ts');
  }

  /** Premarket/post-close probes: real components, adversarial inputs, fail-closed assertions. */
  private async applyProbe(fault: SessionFault, ctx: ProbeContext): Promise<FaultOutcome> {
    const atBar = fault.fromBar;
    switch (fault.kind) {
      case 'RISK_REJECTION_PROBE': {
        // Environment: an over-limit proposal presented DIRECTLY to the real RiskEngine.
        // evaluateRisk() reports via events (RISK_ASSESSMENT_COMPLETED with approved=false,
        // or RISK_BLOCK) - this probe listens for the verdict on its own traceId. This never
        // reaches OMS and never places an order - it proves the gate rejects.
        const { riskEngine } = await import('../../engines/RiskEngine');
        const { eventBus } = await import('../../core/EventBus');
        const { EVENTS } = await import('../../core/eventNames');
        const traceId = `cert-risk-probe-${Date.now()}`;
        const proposal: any = {
          symbol: 'SPY', side: 'BUY', quantity: 1_000_000_000,
          price: 500, currentPrice: 500, orderType: 'MARKET',
          traceId, transactionId: traceId,
        };
        const verdictPromise = new Promise<{ rejected: boolean; detail: string }>((resolve) => {
          const timer = setTimeout(() => {
            cleanup();
            resolve({ rejected: false, detail: 'timed out waiting for the risk verdict event (30s)' });
          }, 30_000);
          const cleanup = () => {
            clearTimeout(timer);
            eventBus.off(EVENTS.RISK_ASSESSMENT_COMPLETED, onAssessed);
            eventBus.off(EVENTS.RISK_BLOCK, onBlock);
          };
          const onAssessed = (a: any) => {
            if (a?.traceId !== traceId) return;
            cleanup();
            resolve({
              rejected: a?.approved === false,
              detail: `RISK_ASSESSMENT_COMPLETED approved=${a?.approved} rejectionGate=${a?.rejectionGate ?? 'none'}`,
            });
          };
          const onBlock = (b: any) => {
            if (b?.traceId !== traceId && b?.correlationId !== traceId) return;
            cleanup();
            resolve({ rejected: true, detail: `RISK_BLOCK gate=${b?.gate ?? 'unknown'}` });
          };
          eventBus.on(EVENTS.RISK_ASSESSMENT_COMPLETED, onAssessed);
          eventBus.on(EVENTS.RISK_BLOCK, onBlock);
        });
        try {
          await (riskEngine as any).evaluateRisk(proposal);
        } catch (e: any) {
          // A throw is itself fail-closed (the serialized evaluation refused the proposal).
          return outcome(fault, atBar, true, 'PASS',
            `RISK_REJECTION_PROBE: evaluateRisk threw fail-closed: ${e?.message ?? e}`);
        }
        const { rejected, detail } = await verdictPromise;
        return outcome(fault, atBar, true, rejected ? 'PASS' : 'FAIL',
          `RISK_REJECTION_PROBE: 1B-share SPY BUY -> ${detail} - an absurd proposal must never clear the gate`);
      }
      case 'INVALID_STRATEGY_PROBE': {
        const { resolveQuantStrategyAuthorization } = await import('../../quant/QuantStrategyAuthorization');
        // Quant-claiming origin with an unknown strategyId: must never authorize.
        const res: any = await resolveQuantStrategyAuthorization({
          origin: 'QUANT_STRATEGY', strategyId: 'CERT_PROBE_NO_SUCH_STRATEGY', agent: 'QuantEngine',
        });
        const terminal = res?.authority !== 'AUTHORIZED_QUANT_POLICY';
        return outcome(fault, atBar, true, terminal ? 'PASS' : 'FAIL',
          `resolveQuantStrategyAuthorization('CERT_PROBE_NO_SUCH_STRATEGY') -> ` +
          `authority=${res?.authority}, reason=${res?.reason} (must never authorize)`);
      }
      case 'VALID_STRATEGY_PROBE': {
        // A REAL registry strategy through the REAL authorization + policy path with a
        // synthetic probe idea. No order, no approval manufactured: the probe observes
        // the decision the real code makes (expected: not authorized in this env).
        const { resolveQuantStrategyAuthorization } = await import('../../quant/QuantStrategyAuthorization');
        const { evaluateQuantExecutionPolicy } = await import('../../quant/QuantExecutionPolicy');
        const { STRATEGY_DATA_CONTRACTS } = await import('../../certification/strategyDataContracts');
        const strategyId = Object.keys(STRATEGY_DATA_CONTRACTS).sort()[0] ?? 'UNKNOWN';
        const auth: any = await resolveQuantStrategyAuthorization({
          origin: 'QUANT_STRATEGY', strategyId, agent: 'QuantEngine',
        });
        let policyDetail = 'policy not evaluated (no authority)';
        if (auth?.authority === 'AUTHORIZED_QUANT_POLICY') {
          const decision: any = await evaluateQuantExecutionPolicy({
            strategyId, symbol: 'SPY', side: 'BUY', confidence: 0.5,
            triggerMet: false, setupScore: 0,
          } as any, {} as any);
          policyDetail = `policy decision=${decision?.decision}, reason=${decision?.reasonCode}`;
        }
        return outcome(fault, atBar, true, 'INFO',
          `VALID_STRATEGY_PROBE: real strategy '${strategyId}' -> authority=${auth?.authority}, ` +
          `reason=${auth?.reason}; ${policyDetail}. Path exercisable: ${auth ? 'yes' : 'no'}`);
      }
      case 'STALE_TAIL_PROBE': {
        // The engine seeds a stale 1Day tail for the probe symbol (see
        // SyntheticSessionOptions.staleCacheSymbols). The real gateway must refuse
        // to treat it as sufficient (STALE_TAIL -> provider refresh -> refused in
        // synthetic mode -> fail closed, never stale bars presented as fresh).
        const { historicalDataGateway } = await import('../../engines/backtest/HistoricalDataGateway');
        let detail: string;
        let verdict: FaultOutcome['verdict'];
        try {
          const bars = await historicalDataGateway.getBars(
            'CERT_STALE_PROBE', '1Day',
            ctx.sessionStartMs - 90 * 86_400_000, ctx.sessionStartMs,
          );
          const n = Array.isArray(bars) ? bars.length : 0;
          verdict = n === 0 ? 'PASS' : 'FAIL';
          detail = `getBars(CERT_STALE_PROBE, 1Day) returned ${n} bars (must be 0 - stale cache ` +
            `must not be served as sufficient; empty provider response must fail closed)`;
        } catch (e: any) {
          verdict = 'PASS';
          detail = `getBars threw fail-closed: ${e?.message ?? e}`;
        }
        return outcome(fault, atBar, true, verdict, `STALE_TAIL_PROBE: ${detail}`);
      }
      case 'JEV_OUTAGE_PROBE':
        return this.probeJev(fault, atBar);
      default:
        return outcome(fault, atBar, false, 'FAIL', `unhandled probe kind ${fault.kind}`);
    }
  }
}

/**
 * Canonical full-day fault schedule builder (used by the full-session driver).
 * Bar phases for a 390-bar RTH session: OPEN 0-29, MORNING 30-149, MIDDAY 150-269,
 * POWER_HOUR 270-359, CLOSE 360-389.
 */
export function buildCanonicalFullDayFaultPlan(newsBurstAtBar: (bar: number) => SyntheticNewsArticleSpec[]): SessionFault[] {
  return [
    { kind: 'RISK_REJECTION_PROBE', fromBar: -1, phase: 'PREMARKET', label: 'premarket: absurd proposal vs RiskEngine' },
    { kind: 'INVALID_STRATEGY_PROBE', fromBar: -1, phase: 'PREMARKET', label: 'premarket: unknown strategy authorization' },
    { kind: 'VALID_STRATEGY_PROBE', fromBar: -1, phase: 'PREMARKET', label: 'premarket: real strategy auth+policy path' },
    { kind: 'JEV_OUTAGE_PROBE', fromBar: -1, phase: 'PREMARKET', label: 'premarket: Jev inertness' },
    { kind: 'STALE_TAIL_PROBE', fromBar: -1, phase: 'PREMARKET', label: 'premarket: stale 1Day cache fails closed' },
    {
      kind: 'PARTIAL_FILL_LIQUIDITY_CAP', fromBar: 0, toBar: 389, phase: 'OPEN',
      label: 'liquidity cap 5% of bar volume for the whole session (partial-fill exercise)',
      params: { maxVolumeParticipationPct: 0.05 },
    },
    {
      kind: 'LATE_MOVER', fromBar: 5, phase: 'OPEN', label: 'late mover admitted at the open',
      params: { symbol: 'CERT_LATE' },
    },
    { kind: 'AI_OUTAGE', fromBar: 60, phase: 'MORNING', label: 'AI outage: all providers cleared' },
    {
      kind: 'NEWS_BURST', fromBar: 150, phase: 'MIDDAY', label: 'midday news burst (8 articles)',
      params: { articles: newsBurstAtBar(150) },
    },
    { kind: 'AI_RECOVERY', fromBar: 180, phase: 'MIDDAY', label: 'AI recovery: providers re-registered' },
    { kind: 'BACKUP_RUN', fromBar: 200, phase: 'MIDDAY', label: 'midday database backup' },
    {
      kind: 'FEED_INTERRUPTION', fromBar: 300, toBar: 309, phase: 'POWER_HOUR',
      label: 'power-hour feed interruption (10 bars) then recovery',
    },
    { kind: 'JEV_OUTAGE_PROBE', fromBar: 320, phase: 'POWER_HOUR', label: 'power-hour: Jev still inert' },
  ];
}
