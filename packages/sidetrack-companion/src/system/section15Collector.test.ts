import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DISPATCH_RECORDED } from '../dispatches/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
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

  // F3 — readSection15Events' typed-store branch (SIDETRACK_EVENT_STORE on)
  // must fold to the SAME criteria as the readMerged fallback branch it
  // replaces on default (store-off) installs.
  it('F3: readSection15Events is store/readMerged equivalent', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sec15-collector-'));
    const replicaId = '77777777-7777-4777-8777-777777777777';
    const peerReplicaId = '88888888-8888-4888-8888-888888888888';
    let seq = 0;
    const eventLog = createEventLog(vaultRoot, {
      replicaId,
      created: true,
      nextSeq: async () => {
        seq += 1;
        return seq;
      },
      peekSeq: () => seq,
      observeSeq: async (incoming: number) => {
        seq = Math.max(seq, incoming);
      },
    });
    const dispatch: AcceptedEvent = {
      clientEventId: 'client-f3-sec15-equiv-1',
      dot: { replicaId: peerReplicaId, seq: 1 },
      deps: {},
      aggregateId: 'dispatch:f3-equiv',
      type: DISPATCH_RECORDED,
      payload: {
        bac_id: 'thread-f3-equiv',
        target: { provider: 'test-provider' },
        createdAt: '2026-07-12T09:00:00.000Z',
        body: '',
      },
      acceptedAtMs: Date.parse('2026-07-12T09:00:00.000Z'),
    };
    await eventLog.importPeerEvent(dispatch);

    const priorStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    try {
      process.env['SIDETRACK_EVENT_STORE'] = '0';
      const withoutStore = await collectSection15Report({
        vaultRoot,
        eventLog,
        now: () => new Date('2026-07-12T10:00:00.000Z'),
      });
      const withoutStoreDispatch = withoutStore.criteria.find(
        (c) => c.id === 'packetsDispatched',
      );
      expect(withoutStoreDispatch?.value).toBe(1);

      process.env['SIDETRACK_EVENT_STORE'] = '1';
      const store = await getCaughtUpSharedEventStore(vaultRoot);
      expect(store).not.toBeNull();
      expect(store?.count()).toBeGreaterThan(0);
      const withStore = await collectSection15Report({
        vaultRoot,
        eventLog,
        now: () => new Date('2026-07-12T10:00:00.000Z'),
      });

      expect(withStore.criteria).toEqual(withoutStore.criteria);
    } finally {
      if (priorStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
      else process.env['SIDETRACK_EVENT_STORE'] = priorStoreFlag;
    }
  });
});
