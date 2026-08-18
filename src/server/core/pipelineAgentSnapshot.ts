/**
 * Mission Control snapshot for idea-agent switches. Read-only; does not start Autobot.
 */
import {
  isTogglableAgentAvailable,
  pipelineAgentsConfig,
} from '../config/pipelineAgents';
import { getPipelineAgentEnabledMap, isPipelineAgentEnabled } from './pipelineAgentGate';
import { isLiveIdeaGenerationEnabled } from './ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';
import { system } from './SystemBootstrap';
import { fundamentalAgent } from '../services/FundamentalAgent';
import { macroAgent } from '../services/MacroAgent';

// 2026-08-18 forensic finding: FundamentalAgent/MacroAgent's `enabled` flag alone could not
// distinguish "gated off" from "enabled but the interval silently stopped ticking" - that gap is
// exactly how a 16h+ dead timer went unnoticed. Only these two currently expose a heartbeat;
// extend the same pattern to other togglable idea agents if they show the same failure mode.
const LAST_TICK_BY_AGENT: Record<string, () => number | null> = {
  FundamentalAgent: () => fundamentalAgent.lastTickAt,
  MacroAgent: () => macroAgent.lastTickAt,
};

export function getPipelineAgentSnapshot() {
  return {
    togglable: pipelineAgentsConfig.togglableIdeaAgents.map((spec) => {
      const available = isTogglableAgentAvailable(spec);
      const lastTickAt = LAST_TICK_BY_AGENT[spec.id]?.() ?? null;
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        enabled: isPipelineAgentEnabled(spec.id),
        available,
        unavailableReason: available ? null : `Requires ${spec.requiresEnv}=true in .env (restart after setting).`,
        keepsBackgroundPipeline: spec.keepsBackgroundPipeline === true,
        lastTickAt,
        lastTickAgeMs: lastTickAt !== null ? Date.now() - lastTickAt : null,
      };
    }),
    alwaysOn: pipelineAgentsConfig.alwaysOn.map((spec) => ({
      id: spec.id,
      label: spec.label,
      reason: spec.reason,
      enabled: true,
    })),
    enabledMap: getPipelineAgentEnabledMap(),
    autobotEnabled: tradingEngine.state.enabled === true,
    liveIdeaGenerationEnabled: isLiveIdeaGenerationEnabled(),
    tradingState: tradingEngine.state.tradingState,
    emergencyStopActive: tradingEngine.state.emergencyStopActive === true,
    workersRunning: system.getStatus().running,
  };
}
