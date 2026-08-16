/**
 * Role-scoped model outputs. A FORECAST model cannot cast a RISK vote.
 * Does not majority-vote an order.
 */
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

const file = loadRepoConfigJson<{ roles: Record<string, string[]> }>('modelRoles.json');

export type ModelRole = keyof typeof file.roles | string;

export function roleForAgent(agentOrModelId: string): string | null {
  for (const [role, members] of Object.entries(file.roles)) {
    if (members.includes(agentOrModelId)) return role;
  }
  return null;
}

export function canVote(agentOrModelId: string, role: string): boolean {
  return roleForAgent(agentOrModelId) === role;
}

export interface RoleConsensusInput {
  agent: string;
  role: string;
  present: boolean;
  stale: boolean;
  lowConfidence: boolean;
  side?: 'BUY' | 'SELL' | 'HOLD';
}

export function summarizeRoleConsensus(rows: RoleConsensusInput[]): {
  agreement: number;
  disagreement: number;
  missing: number;
  stale: number;
  lowConfidence: number;
  note: string;
} {
  const inRole = rows.filter((r) => canVote(r.agent, r.role) && r.present);
  const missing = rows.filter((r) => !r.present).length;
  const stale = rows.filter((r) => r.stale).length;
  const lowConfidence = rows.filter((r) => r.lowConfidence).length;
  const buys = inRole.filter((r) => r.side === 'BUY').length;
  const sells = inRole.filter((r) => r.side === 'SELL').length;
  const agreement = Math.max(buys, sells);
  const disagreement = Math.min(buys, sells);
  return {
    agreement,
    disagreement,
    missing,
    stale,
    lowConfidence,
    note: 'Role-scoped tallies only. Low-quality evidence must not become a high-confidence trade. ChiefTrader + RiskEngine still authorize.',
  };
}
