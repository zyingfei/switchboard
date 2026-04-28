import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { LiveVaultReader, type ReviewEvent } from './liveVaultReader.js';

interface CaptureEventForTest {
  readonly threadUrl: string;
  readonly capturedAt: string;
  readonly turns: readonly {
    readonly role: 'user' | 'assistant' | 'system' | 'unknown';
    readonly text: string;
    readonly ordinal: number;
    readonly capturedAt: string;
  }[];
}

const writeEventLog = async (
  vaultPath: string,
  date: string,
  events: readonly CaptureEventForTest[],
): Promise<void> => {
  await mkdir(join(vaultPath, '_BAC', 'events'), { recursive: true });
  await writeFile(
    join(vaultPath, '_BAC', 'events', `${date}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
};

const buildReviewEvent = (overrides: Partial<ReviewEvent>): ReviewEvent => ({
  bac_id: 'review_base',
  sourceThreadId: 'thread_alpha',
  sourceTurnOrdinal: 1,
  provider: 'chatgpt',
  verdict: 'open',
  reviewerNote: 'Needs follow-up',
  spans: [
    {
      id: 'span_1',
      text: 'Claim text',
      comment: 'Check this claim',
      capturedAt: '2026-04-26T20:00:00.000Z',
    },
  ],
  outcome: 'save',
  createdAt: '2026-04-26T20:00:00.000Z',
  ...overrides,
});

const writeReviewLog = async (
  vaultPath: string,
  date: string,
  events: readonly ReviewEvent[],
): Promise<void> => {
  await mkdir(join(vaultPath, '_BAC', 'reviews'), { recursive: true });
  await writeFile(
    join(vaultPath, '_BAC', 'reviews', `${date}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
};

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

  it('reads review JSONL files newest first', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-reviews-order-'));
    await writeReviewLog(vaultPath, '2026-04-25', [
      buildReviewEvent({
        bac_id: 'review_oldest',
        createdAt: '2026-04-25T21:00:00.000Z',
      }),
    ]);
    await writeReviewLog(vaultPath, '2026-04-26', [
      buildReviewEvent({
        bac_id: 'review_evening',
        createdAt: '2026-04-26T22:00:00.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_late',
        createdAt: '2026-04-26T23:00:00.000Z',
      }),
    ]);
    await writeReviewLog(vaultPath, '2026-04-27', [
      buildReviewEvent({
        bac_id: 'review_newest',
        createdAt: '2026-04-27T01:00:00.000Z',
      }),
    ]);

    const result = await new LiveVaultReader(vaultPath).readReviews({ limit: 4 });

    expect(result.data.map((event) => event.bac_id)).toEqual([
      'review_newest',
      'review_late',
      'review_evening',
      'review_oldest',
    ]);
  });

  it('limits review results', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-reviews-limit-'));
    await writeReviewLog(vaultPath, '2026-04-27', [
      buildReviewEvent({
        bac_id: 'review_first',
        createdAt: '2026-04-27T03:00:00.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_second',
        createdAt: '2026-04-27T02:00:00.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_third',
        createdAt: '2026-04-27T01:00:00.000Z',
      }),
    ]);

    const result = await new LiveVaultReader(vaultPath).readReviews({ limit: 2 });

    expect(result.data.map((event) => event.bac_id)).toEqual(['review_first', 'review_second']);
  });

  it('filters reviews by since timestamp', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-reviews-since-'));
    await writeReviewLog(vaultPath, '2026-04-26', [
      buildReviewEvent({
        bac_id: 'review_before',
        createdAt: '2026-04-26T11:59:59.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_at_since',
        createdAt: '2026-04-26T12:00:00.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_after',
        createdAt: '2026-04-26T13:00:00.000Z',
      }),
    ]);

    const result = await new LiveVaultReader(vaultPath).readReviews({
      since: '2026-04-26T12:00:00.000Z',
    });

    expect(result.data.map((event) => event.bac_id)).toEqual(['review_after', 'review_at_since']);
  });

  it('filters reviews by thread and verdict', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-reviews-filter-'));
    await writeReviewLog(vaultPath, '2026-04-27', [
      buildReviewEvent({
        bac_id: 'review_keep',
        sourceThreadId: 'thread_alpha',
        verdict: 'agree',
        createdAt: '2026-04-27T03:00:00.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_wrong_verdict',
        sourceThreadId: 'thread_alpha',
        verdict: 'open',
        createdAt: '2026-04-27T02:00:00.000Z',
      }),
      buildReviewEvent({
        bac_id: 'review_wrong_thread',
        sourceThreadId: 'thread_beta',
        verdict: 'agree',
        createdAt: '2026-04-27T01:00:00.000Z',
      }),
    ]);

    const result = await new LiveVaultReader(vaultPath).readReviews({
      threadId: 'thread_alpha',
      verdict: 'agree',
    });

    expect(result.data.map((event) => event.bac_id)).toEqual(['review_keep']);
  });

  it('reads recent turns for a threadUrl, deduped by ordinal newest-wins', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-turns-'));
    const threadUrl = 'https://claude.ai/chat/turns-mcp-test';
    await writeEventLog(vaultPath, '2026-04-26', [
      {
        threadUrl,
        capturedAt: '2026-04-26T20:00:00.000Z',
        turns: [
          {
            role: 'assistant',
            text: 'first capture v1',
            ordinal: 0,
            capturedAt: '2026-04-26T20:00:00.000Z',
          },
        ],
      },
      {
        threadUrl,
        capturedAt: '2026-04-26T22:00:00.000Z',
        turns: [
          {
            role: 'assistant',
            text: 'first capture v2',
            ordinal: 0,
            capturedAt: '2026-04-26T22:00:00.000Z',
          },
          { role: 'user', text: 'follow-up', ordinal: 1, capturedAt: '2026-04-26T22:01:00.000Z' },
        ],
      },
    ]);

    const all = await new LiveVaultReader(vaultPath).readTurns({ threadUrl });
    expect(all.data).toHaveLength(2);
    const byOrdinal = new Map(all.data.map((turn) => [turn.ordinal, turn.text]));
    expect(byOrdinal.get(0)).toBe('first capture v2');
    expect(byOrdinal.get(1)).toBe('follow-up');

    const onlyAssistant = await new LiveVaultReader(vaultPath).readTurns({
      threadUrl,
      role: 'assistant',
    });
    expect(onlyAssistant.data).toHaveLength(1);
    expect(onlyAssistant.data[0]?.text).toBe('first capture v2');
  });
});
