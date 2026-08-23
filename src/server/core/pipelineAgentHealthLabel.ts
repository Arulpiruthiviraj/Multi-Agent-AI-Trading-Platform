/**
 * Operator-facing pipeline agent health labels.
 *
 * Distinguishes "enabled / listening but waiting for MARKET_DATA" from FAILED.
 * Autobot off suppresses MarketDataWorker tick emission by design — that is
 * IDLE_WAITING_FOR_MARKET_DATA, never DEAD/FAILED.
 *
 * Canonical operational set:
 *   STARTING | IDLE_WAITING_FOR_MARKET_DATA | RUNNING | DEGRADED | UNAVAILABLE | FAILED
 * Plus availability/arming labels: ENV_OFF | OFFLINE | NOT_ARMED | GATED
 */
export type PipelineAgentHealthLabel =
  | 'ENV_OFF'
  | 'OFFLINE'
  | 'NOT_ARMED'
  | 'STARTING'
  | 'IDLE_WAITING_FOR_MARKET_DATA'
  | 'RUNNING'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'FAILED'
  | 'GATED';

export interface ResolvePipelineAgentHealthLabelInput {
  available: boolean;
  enabled: boolean;
  ideaWorkersArmed: boolean;
  keepsBackgroundPipeline: boolean;
  /** Heartbeat lastTickAt (or agent-specific lastTickAt override). */
  lastTickAt: number | null;
  alive: boolean;
  currentState: string;
  consecutiveFailures: number;
  /** Autobot on + TRADING_ENABLED (tick bus can emit MARKET_DATA). */
  autobotTickBusArmed: boolean;
  /**
   * For KronosEngine: Chronos /health readiness.
   * null = not applicable (non-Kronos agents).
   * false = Chronos down → UNAVAILABLE.
   */
  chronosAvailable?: boolean | null;
}

/**
 * Pure mapping — unit-tested. Does not weaken RiskEngine data_freshness.
 */
export function resolvePipelineAgentHealthLabel(
  input: ResolvePipelineAgentHealthLabelInput,
): PipelineAgentHealthLabel {
  const {
    available,
    enabled,
    ideaWorkersArmed,
    keepsBackgroundPipeline,
    lastTickAt,
    alive,
    currentState,
    consecutiveFailures,
    autobotTickBusArmed,
    chronosAvailable = null,
  } = input;

  if (!available) return 'ENV_OFF';
  if (!enabled) return 'OFFLINE';
  if (!ideaWorkersArmed && keepsBackgroundPipeline !== true) return 'NOT_ARMED';

  // Chronos /health down: honest UNAVAILABLE even if the listener is armed.
  if (chronosAvailable === false) return 'UNAVAILABLE';

  const neverTicked = lastTickAt === null;
  const tickBusQuiet = !autobotTickBusArmed;

  // enabled+available+no ticks yet, or Autobot off so MARKET_DATA is not emitted → waiting, not dead.
  if (neverTicked || (tickBusQuiet && !alive)) {
    return 'IDLE_WAITING_FOR_MARKET_DATA';
  }

  if (currentState === 'FAILED' || consecutiveFailures >= 3) return 'FAILED';
  if (currentState === 'GATED') return 'GATED';

  if (!alive) {
    // Autobot on, ticks expected, heartbeat stale → truly failed.
    if (autobotTickBusArmed) return 'FAILED';
    return 'IDLE_WAITING_FOR_MARKET_DATA';
  }

  if (consecutiveFailures > 0) return 'DEGRADED';
  if (currentState === 'TICKING') return 'STARTING';
  return 'RUNNING';
}

/** Labels that mean the agent path is "up" enough for a non-rose Mission Control lamp. */
export function isPipelineAgentHealthLabelHealthy(label: PipelineAgentHealthLabel): boolean {
  return label === 'RUNNING' || label === 'GATED' || label === 'DEGRADED' || label === 'STARTING';
}

/** Map pipeline operational labels onto Digital Twin VisualStatus vocabulary. */
export type TwinHealthVisualStatus =
  | 'IDLE'
  | 'PULSE'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAIL'
  | 'IDLE_WAITING_FOR_MARKET_DATA'
  | 'RUNNING'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'FAILED'
  | 'STARTING';

export function mapHealthLabelToVisualStatus(label: PipelineAgentHealthLabel): TwinHealthVisualStatus {
  switch (label) {
    case 'RUNNING':
      return 'RUNNING';
    case 'STARTING':
      return 'STARTING';
    case 'IDLE_WAITING_FOR_MARKET_DATA':
      return 'IDLE_WAITING_FOR_MARKET_DATA';
    case 'DEGRADED':
    case 'GATED':
      return 'DEGRADED';
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
    case 'FAILED':
      return 'FAILED';
    case 'ENV_OFF':
    case 'OFFLINE':
    case 'NOT_ARMED':
    default:
      return 'IDLE';
  }
}
