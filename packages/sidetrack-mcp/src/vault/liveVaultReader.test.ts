import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { LiveVaultReader } from './liveVaultReader.js';

describe('LiveVaultReader', () => {
  it('reads live _BAC thread, queue, reminder, and event files', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-vault-'));
    await mkdir(join(vaultPath, '_BAC', 'threads'), { recursive: true });
    await mkdir(join(vaultPath, '_BAC', 'queue'), { recursive: true });
    await mkdir(join(vaultPath, '_BAC', 'reminders'), { recursive: true });
    await mkdir(join(vaultPath, '_BAC', 'events'), { recursive: true });

    await writeFile(
      join(vaultPath, '_BAC', 'threads', 'thread_1.json'),
      JSON.stringify({
        bac_id: 'thread_1',
        provider: 'chatgpt',
        threadUrl: 'https://chatgpt.com/c/1',
        title: 'Live thread',
        lastSeenAt: '2026-04-26T21:30:00.000Z',
      }),
    );
    await writeFile(
      join(vaultPath, '_BAC', 'queue', 'queue_1.json'),
      JSON.stringify({ bac_id: 'queue_1', text: 'Follow up', scope: 'thread' }),
    );
    await writeFile(
      join(vaultPath, '_BAC', 'reminders', 'reminder_1.json'),
      JSON.stringify({ bac_id: 'reminder_1', threadId: 'thread_1', provider: 'chatgpt' }),
    );
    await writeFile(
      join(vaultPath, '_BAC', 'events', '2026-04-26.jsonl'),
      `${JSON.stringify({ bac_id: 'evt_1', title: 'Event' })}\n`,
    );

    const snapshot = await new LiveVaultReader(vaultPath).readSnapshot();

    expect(snapshot.threads[0]?.title).toBe('Live thread');
    expect(snapshot.queueItems[0]?.text).toBe('Follow up');
    expect(snapshot.reminders[0]?.threadId).toBe('thread_1');
    expect(snapshot.events[0]?.['title']).toBe('Event');
  });

  it('reads dispatch JSONL files newest first with in-memory filters', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-dispatches-'));
    await mkdir(join(vaultPath, '_BAC', 'dispatches'), { recursive: true });

    await writeFile(
      join(vaultPath, '_BAC', 'dispatches', '2026-04-25.jsonl'),
      `${JSON.stringify({
        bac_id: 'disp_oldest',
        kind: 'research',
        target: { provider: 'claude', mode: 'paste' },
        workstreamId: 'ws_1',
        title: 'Older dispatch',
        body: 'Older body',
        createdAt: '2026-04-25T21:00:00.000Z',
        redactionSummary: { matched: 0, categories: [] },
        tokenEstimate: 2,
        status: 'sent',
      })}\n`,
    );
    await writeFile(
      join(vaultPath, '_BAC', 'dispatches', '2026-04-26.jsonl'),
      `${JSON.stringify({
        bac_id: 'disp_evening',
        kind: 'coding',
        target: { provider: 'chatgpt', mode: 'paste' },
        workstreamId: 'ws_1',
        title: 'Evening dispatch',
        body: 'Evening body',
        createdAt: '2026-04-26T22:00:00.000Z',
        redactionSummary: { matched: 0, categories: [] },
        tokenEstimate: 2,
        status: 'sent',
      })}\n${JSON.stringify({
        bac_id: 'disp_other_ws',
        kind: 'review',
        target: { provider: 'chatgpt', mode: 'paste' },
        workstreamId: 'ws_2',
        title: 'Other workstream dispatch',
        body: 'Other body',
        createdAt: '2026-04-26T23:00:00.000Z',
        redactionSummary: { matched: 0, categories: [] },
        tokenEstimate: 2,
        status: 'sent',
      })}\n`,
    );
    await writeFile(
      join(vaultPath, '_BAC', 'dispatches', '2026-04-27.jsonl'),
      `${JSON.stringify({
        bac_id: 'disp_newest',
        kind: 'coding',
        target: { provider: 'codex', mode: 'paste' },
        workstreamId: 'ws_1',
        title: 'Newest dispatch',
        body: 'Newest body',
        createdAt: '2026-04-27T01:00:00.000Z',
        redactionSummary: { matched: 0, categories: [] },
        tokenEstimate: 2,
        status: 'sent',
      })}\n`,
    );

    const reader = new LiveVaultReader(vaultPath);
    const ordered = await reader.readDispatches({ limit: 3 });
    const filtered = await reader.readDispatches({
      since: '2026-04-26T12:00:00.000Z',
      workstreamId: 'ws_1',
      provider: 'chatgpt',
    });

    expect(ordered.data.map((event) => event.bac_id)).toEqual([
      'disp_newest',
      'disp_other_ws',
      'disp_evening',
    ]);
    expect(filtered.data.map((event) => event.bac_id)).toEqual(['disp_evening']);
  });
});
