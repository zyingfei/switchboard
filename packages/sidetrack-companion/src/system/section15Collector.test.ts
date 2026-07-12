import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectSection15Report } from './section15Collector.js';
import { MCP_CONTEXT_PACK_TOOL } from './section15Counters.js';

// The exact audit-line shape the streamable-HTTP MCP context_pack sink
// writes (packages/sidetrack-mcp/src/server/contextPackAudit.ts). This
// test proves the §15 collector's audit reader parses that line and the
// counter observes it — closing the criterion-5 loop end to end, so the
// counter is no longer structurally unfalsifiable.
const contextPackAuditLine = (): string =>
  `${JSON.stringify({
    requestId: '11111111-1111-4111-8111-111111111111',
    route: 'mcp.workstreams.context_pack',
    outcome: 'success',
    timestamp: '2026-07-12T09:30:00.000Z',
    agent: 'mcp:codex',
    tool: MCP_CONTEXT_PACK_TOOL,
    argsSummary: 'streamable-http context_pack',
    scope: 'bac_ws_7',
    trustModeActive: false,
  })}\n`;

describe('section15 collector — criterion 5 audit read', () => {
  it('counts a context_pack audit line the MCP sink wrote', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sec15-collector-'));
    const auditDir = join(vaultRoot, '_BAC', 'audit');
    await mkdir(auditDir, { recursive: true });
    await writeFile(join(auditDir, '2026-07-12.jsonl'), contextPackAuditLine(), 'utf8');

    // eventLog omitted → events degrade to empty; only the audit read
    // matters for this criterion.
    const report = await collectSection15Report({
      vaultRoot,
      now: () => new Date('2026-07-12T10:00:00.000Z'),
    });

    const mcp = report.criteria.find((c) => c.id === 'mcpContextPackSessions');
    expect(mcp?.value).toBe(1);
    expect(mcp?.met).toBe(true);
  });

  it('reports zero (unfalsified, not throwing) when no audit dir exists', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sec15-collector-'));
    const report = await collectSection15Report({
      vaultRoot,
      now: () => new Date('2026-07-12T10:00:00.000Z'),
    });
    const mcp = report.criteria.find((c) => c.id === 'mcpContextPackSessions');
    expect(mcp?.value).toBe(0);
    expect(mcp?.met).toBe(false);
  });
});
