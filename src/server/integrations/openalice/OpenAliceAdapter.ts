/**
 * ==========================================================
 * Module: OpenAliceAdapter
 *
 * Purpose:
 * Real MCP-based adapter implementing ExternalVerificationProvider against a live OpenAlice
 * instance. Read-only from Argus's perspective: the only tools called are `issue_create`
 * (to file a research request) and, via pollForReports(), `inbox_read` (to check for a
 * reply). Never calls anything trading-related, never receives credentials, never touches
 * BrokerManager/OrderManagementService/RiskEngine.
 *
 * Two real OpenAlice mechanics this file works around (confirmed by reading OpenAlice's own
 * source - src/tool/issue-tools.ts, src/tool/inbox-read.ts):
 *  - issue_create's `when` field must be set or the created issue is inert (a board item no
 *    agent ever picks up). This adapter always sets `when: {kind:'at', at: <now>}` so it
 *    dispatches immediately.
 *  - inbox_read has no filter by issue id server-side; every entry's `origin.issueId` is
 *    checked client-side against pending requestIds to find a match.
 *
 * NOT live-verified against a real running OpenAlice instance - no instance exists in this
 * environment. Verified against OpenAlice's real, read source-level tool schemas only.
 * ==========================================================
 */
import { OpenAliceMcpClient } from './OpenAliceMcpClient';
import { buildVerificationPrompt } from './prompt';
import type {
  ExternalVerificationProvider,
  VerificationHealth,
  VerificationRequest,
  VerificationResult,
} from './types';

interface InboxEntry {
  id: string;
  ts?: string;
  comments?: string;
  origin?: { issueId?: string };
}

interface InboxReadResponse {
  ok: boolean;
  count: number;
  hasMore: boolean;
  entries: InboxEntry[];
}

function extractToolText(callToolResult: any): string {
  const content = callToolResult?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

/** Pulls the first ```json ... ``` fenced block out of free text. Returns null if absent/unparseable. */
export function parseVerificationJson(raw: string): {
  direction: 'AGREE' | 'DISAGREE' | 'NO_OPINION';
  confidence: number;
  thesis: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
} | null {
  const match = raw.match(/```json\s*([\s\S]*?)```/i);
  const jsonText = match ? match[1] : raw;
  try {
    const parsed = JSON.parse(jsonText.trim());
    if (!['AGREE', 'DISAGREE', 'NO_OPINION'].includes(parsed.direction)) return null;
    if (typeof parsed.confidence !== 'number') return null;
    return {
      direction: parsed.direction,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      thesis: typeof parsed.thesis === 'string' ? parsed.thesis : '',
      supportingEvidence: Array.isArray(parsed.supportingEvidence) ? parsed.supportingEvidence.filter((s: any) => typeof s === 'string') : [],
      contradictingEvidence: Array.isArray(parsed.contradictingEvidence) ? parsed.contradictingEvidence.filter((s: any) => typeof s === 'string') : [],
    };
  } catch {
    return null;
  }
}

export class OpenAliceAdapter implements ExternalVerificationProvider {
  readonly name = 'OpenAlice';
  private readonly mcp: OpenAliceMcpClient;

  constructor(mcpUrl: string) {
    this.mcp = new OpenAliceMcpClient(mcpUrl);
  }

  async healthCheck(): Promise<VerificationHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const tools = await this.mcp.listToolNames();
      const hasRequired = tools.includes('issue_create') && tools.includes('inbox_read');
      return {
        reachable: hasRequired,
        detail: hasRequired
          ? `Connected. ${tools.length} tool(s) available, including issue_create and inbox_read.`
          : `Connected but missing expected tools. Available: ${tools.join(', ') || 'none'}`,
        checkedAt,
      };
    } catch (e: any) {
      return { reachable: false, detail: `Unreachable: ${e?.message ?? e}`, checkedAt };
    }
  }

  /** Fire-and-forget. Files the OpenAlice issue and returns - never awaits a verdict. */
  async requestVerification(request: VerificationRequest): Promise<void> {
    const what = buildVerificationPrompt(request);
    await this.mcp.callTool('issue_create', {
      id: request.requestId,
      title: `[Argus] Verify ${request.side} ${request.symbol} (${request.mode})`,
      what,
      when: { kind: 'at', at: new Date().toISOString() },
    });
  }

  /**
   * Checks the OpenAlice inbox for reports matching any of the given pending requestIds.
   * Not part of ExternalVerificationProvider - OpenAlice-specific polling mechanics, called
   * only by OpenAliceVerificationService's background loop.
   */
  async pollForReports(pendingRequestIds: Set<string>): Promise<Map<string, VerificationResult>> {
    const found = new Map<string, VerificationResult>();
    if (pendingRequestIds.size === 0) return found;

    const raw = await this.mcp.callTool('inbox_read', { self: true, limit: 50 });
    const text = extractToolText(raw);
    let parsed: InboxReadResponse | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return found;
    }
    if (!parsed?.entries) return found;

    for (const entry of parsed.entries) {
      const issueId = entry.origin?.issueId;
      if (!issueId || !pendingRequestIds.has(issueId)) continue;
      const comments = entry.comments ?? '';
      const verdict = parseVerificationJson(comments);
      if (!verdict) continue;
      found.set(issueId, {
        requestId: issueId,
        traceId: '', // filled in by the caller, which knows the original request
        symbol: '',
        receivedAt: new Date().toISOString(),
        latencyMs: 0,
        raw: comments,
        ...verdict,
      });
    }
    return found;
  }
}
