import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAliceAdapter, parseVerificationJson } from './OpenAliceAdapter';
import { ensureArgusWorkspaceId } from './OpenAliceWorkspace';
import type { VerificationRequest } from './types';

// Real network calls to OpenAlice's web API (workspace list/create) are exercised by
// OpenAliceWorkspace's own tests. These adapter tests mock the resolver so they stay hermetic -
// otherwise a real OpenAlice instance running on this machine (as it did during development)
// resolves a real workspace id, silently rebinds `this.mcp` past the test's injected mock, and
// every test below starts hitting a real (or refused) network connection instead.
vi.mock('./OpenAliceWorkspace', () => ({
  ensureArgusWorkspaceId: vi.fn().mockResolvedValue(null),
}));

describe('parseVerificationJson', () => {
  it('parses a well-formed fenced json block', () => {
    const raw = 'Here is my finding:\n```json\n{"direction":"AGREE","confidence":0.8,"thesis":"looks solid","supportingEvidence":["a"],"contradictingEvidence":[]}\n```\nend of report';
    const parsed = parseVerificationJson(raw);
    expect(parsed).toEqual({
      direction: 'AGREE',
      confidence: 0.8,
      thesis: 'looks solid',
      supportingEvidence: ['a'],
      contradictingEvidence: [],
    });
  });

  it('clamps out-of-range confidence into [0,1]', () => {
    const raw = '```json\n{"direction":"DISAGREE","confidence":1.4,"thesis":"x","supportingEvidence":[],"contradictingEvidence":[]}\n```';
    const parsed = parseVerificationJson(raw);
    expect(parsed?.confidence).toBe(1);
  });

  it('returns null for an invalid direction value', () => {
    const raw = '```json\n{"direction":"MAYBE","confidence":0.5}\n```';
    expect(parseVerificationJson(raw)).toBeNull();
  });

  it('returns null for unparseable text (no agent ever replied in the expected format)', () => {
    expect(parseVerificationJson('sorry, I could not find anything conclusive')).toBeNull();
  });

  it('falls back to parsing the whole string when there is no fence', () => {
    const raw = '{"direction":"NO_OPINION","confidence":0,"thesis":"","supportingEvidence":[],"contradictingEvidence":[]}';
    const parsed = parseVerificationJson(raw);
    expect(parsed?.direction).toBe('NO_OPINION');
  });
});

describe('OpenAliceAdapter', () => {
  const request: VerificationRequest = {
    requestId: 'req-1',
    traceId: 'trace-1',
    symbol: 'AAPL',
    side: 'BUY',
    mode: 'TRADE_VERIFICATION',
    argusConfidence: 0.8,
    argusReasoning: 'RSI oversold bounce',
    createdAt: new Date().toISOString(),
  };

  function adapterWithMockClient(mockCallTool: ReturnType<typeof vi.fn>) {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = { callTool: mockCallTool, listToolNames: vi.fn() };
    return adapter;
  }

  beforeEach(() => {
    vi.mocked(ensureArgusWorkspaceId).mockReset().mockResolvedValue(null);
  });

  it('rebinds to the workspace-scoped MCP URL once a workspace id resolves', async () => {
    vi.mocked(ensureArgusWorkspaceId).mockResolvedValueOnce('ws-123');
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    const initialMcp = (adapter as any).mcp;

    await (adapter as any).ensureWorkspaceScoped();

    expect((adapter as any).workspaceScoped).toBe(true);
    expect((adapter as any).mcp).not.toBe(initialMcp);
    expect((adapter as any).mcp.mcpUrl).toBe('http://localhost:9999/mcp/ws-123');
  });

  it('leaves the bare MCP URL bound when no workspace id resolves', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    const initialMcp = (adapter as any).mcp;

    await (adapter as any).ensureWorkspaceScoped();

    expect((adapter as any).workspaceScoped).toBe(false);
    expect((adapter as any).mcp).toBe(initialMcp);
  });

  it('requestVerification calls issue_create with an immediate "when" and the request id', async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const adapter = adapterWithMockClient(callTool);

    await adapter.requestVerification(request);

    expect(callTool).toHaveBeenCalledTimes(1);
    const [toolName, args] = callTool.mock.calls[0];
    expect(toolName).toBe('issue_create');
    expect(args.id).toBe('req-1');
    expect(args.when).toEqual(expect.objectContaining({ kind: 'at' }));
    expect(args.what).toContain('AAPL');
    expect(args.what).toContain('```json');
  });

  it('healthCheck reports reachable only when both required tools are present', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = { listToolNames: vi.fn().mockResolvedValue(['issue_create', 'inbox_read', 'other_tool']) };
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(true);
  });

  it('healthCheck reports unreachable when a required tool is missing', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = { listToolNames: vi.fn().mockResolvedValue(['issue_create']) };
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
  });

  it('healthCheck names a trading MCP as the wrong server, never READY', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = {
      listToolNames: vi.fn().mockResolvedValue(['placeOrder', 'getQuote', 'tradingCommit']),
    };
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.detail).toMatch(/Wrong MCP/);
    expect(health.detail).toMatch(/:wsId/);
  });

  it('healthCheck reports unreachable on a connection failure, never throws', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = { listToolNames: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain('ECONNREFUSED');
  });

  it('pollForReports matches inbox entries to pending requests by origin.issueId', async () => {
    const inboxResponse = {
      ok: true,
      count: 1,
      hasMore: false,
      entries: [
        {
          id: 'entry-1',
          comments: '```json\n{"direction":"AGREE","confidence":0.7,"thesis":"t","supportingEvidence":[],"contradictingEvidence":[]}\n```',
          origin: { issueId: 'req-1' },
        },
      ],
    };
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(inboxResponse) }] });
    const adapter = adapterWithMockClient(callTool);

    const results = await adapter.pollForReports(new Set(['req-1']));

    expect(callTool).toHaveBeenCalledWith('inbox_read', { self: true, limit: 50 });
    expect(results.has('req-1')).toBe(true);
    expect(results.get('req-1')?.direction).toBe('AGREE');
  });

  it('pollForReports ignores inbox entries whose issueId is not pending', async () => {
    const inboxResponse = {
      ok: true,
      count: 1,
      hasMore: false,
      entries: [
        { id: 'entry-1', comments: '```json\n{"direction":"AGREE","confidence":0.7}\n```', origin: { issueId: 'unrelated-issue' } },
      ],
    };
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(inboxResponse) }] });
    const adapter = adapterWithMockClient(callTool);

    const results = await adapter.pollForReports(new Set(['req-1']));
    expect(results.size).toBe(0);
  });

  it('pollForReports returns empty when there are no pending requests, without calling inbox_read', async () => {
    const callTool = vi.fn();
    const adapter = adapterWithMockClient(callTool);
    const results = await adapter.pollForReports(new Set());
    expect(results.size).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
  });
});
