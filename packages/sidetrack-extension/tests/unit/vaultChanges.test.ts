import { describe, expect, it, vi } from 'vitest';

import {
  createVaultChangesClient,
  parseSseStream,
  type VaultChangeEvent,
} from '../../src/companion/vaultChanges';

const makeStream = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

const collect = async (stream: ReadableStream<Uint8Array>): Promise<VaultChangeEvent[]> => {
  const reader = stream.getReader();
  const events: VaultChangeEvent[] = [];
  for await (const event of parseSseStream(reader)) {
    events.push(event);
  }
  return events;
};

describe('parseSseStream', () => {
  it('decodes data: frames split across multiple chunks', async () => {
    const stream = makeStream([
      ': sidetrack vault changes connected\n\n',
      'data: {"type":"created","relPath":"_BAC/threads/abc.json',
      '","at":"2026-05-05T12:00:00.000Z"}\n\n',
      ': heartbeat\n\n',
      'data: {"type":"modified","relPath":"_BAC/review-drafts/xyz.json","at":"2026-05-05T12:00:01.000Z"}\n\n',
    ]);
    const events = await collect(stream);
    expect(events).toEqual([
      {
        type: 'created',
        relPath: '_BAC/threads/abc.json',
        at: '2026-05-05T12:00:00.000Z',
      },
      {
        type: 'modified',
        relPath: '_BAC/review-drafts/xyz.json',
        at: '2026-05-05T12:00:01.000Z',
      },
    ]);
  });

  it('skips frames whose JSON cannot be parsed without throwing', async () => {
    const stream = makeStream([
      'data: {"bad":"json",\n\n',
      'data: {"type":"created","relPath":"_BAC/x","at":"2026-05-05T12:00:00.000Z"}\n\n',
    ]);
    const events = await collect(stream);
    expect(events.map((event) => event.relPath)).toEqual(['_BAC/x']);
  });

  it('drops events with unknown type or missing fields', async () => {
    const stream = makeStream([
      'data: {"type":"renamed","relPath":"_BAC/x","at":"t"}\n\n',
      'data: {"type":"created","relPath":"_BAC/x"}\n\n',
      'data: {"type":"modified","relPath":"_BAC/x","at":"2026-05-05T12:00:00.000Z"}\n\n',
    ]);
    const events = await collect(stream);
    expect(events).toEqual([
      { type: 'modified', relPath: '_BAC/x', at: '2026-05-05T12:00:00.000Z' },
    ]);
  });
});

describe('createVaultChangesClient', () => {
  const config = { url: 'http://127.0.0.1:7037', bridgeKey: 'k' };

  it('routes events to subscribers whose prefix matches', async () => {
    const stream = makeStream([
      'data: {"type":"created","relPath":"_BAC/review-drafts/abc.json","at":"2026-05-05T12:00:00.000Z"}\n\n',
      'data: {"type":"modified","relPath":"_BAC/threads/xyz.json","at":"2026-05-05T12:00:01.000Z"}\n\n',
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const client = createVaultChangesClient({
      resolveCompanion: () => config,
      fetchImpl: fetchImpl,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const reviewEvents: VaultChangeEvent[] = [];
    const threadEvents: VaultChangeEvent[] = [];
    const unReview = client.subscribe({
      prefix: '_BAC/review-drafts/',
      onEvent: (event) => reviewEvents.push(event),
    });
    const unThread = client.subscribe({
      prefix: '_BAC/threads/',
      onEvent: (event) => threadEvents.push(event),
    });

    // Allow the runner microtask + the stream to drain.
    await new Promise((resolve) => setTimeout(resolve, 30));
    unReview();
    unThread();
    await client.stop();

    expect(reviewEvents.map((e) => e.relPath)).toEqual(['_BAC/review-drafts/abc.json']);
    expect(threadEvents.map((e) => e.relPath)).toEqual(['_BAC/threads/xyz.json']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:7037/v1/vault/changes',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-bac-bridge-key': 'k' }),
      }),
    );
  });

  it('fires onReconcile with null on the first connect (no prior events seen)', async () => {
    const encoder = new TextEncoder();
    const openStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"created","relPath":"_BAC/x","at":"2026-05-05T12:00:00.000Z"}\n\n',
          ),
        );
        // Don't close — keep the run loop in stream consumption.
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(openStream, { status: 200 }));
    const client = createVaultChangesClient({
      resolveCompanion: () => config,
      fetchImpl: fetchImpl,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const reconcileCalls: (string | null)[] = [];
    const events: VaultChangeEvent[] = [];
    const unsubscribe = client.subscribe({
      prefix: '_BAC/',
      onEvent: (event) => events.push(event),
      onReconcile: (since) => {
        reconcileCalls.push(since);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    unsubscribe();
    await client.stop();

    expect(reconcileCalls).toEqual([null]);
    expect(events.map((event) => event.relPath)).toEqual(['_BAC/x']);
  });

  it('retries with backoff when fetch rejects then recovers', async () => {
    // The "happy" stream emits one event then stays open so the
    // run-loop sits in stream consumption rather than spinning new
    // fetches at the 1ms backoff.
    const encoder = new TextEncoder();
    const happyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"modified","relPath":"_BAC/r","at":"2026-05-05T12:00:00.000Z"}\n\n',
          ),
        );
        // Don't close — leaves the run loop reading indefinitely.
      },
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(new Response(happyStream, { status: 200 }));
    const client = createVaultChangesClient({
      resolveCompanion: () => config,
      fetchImpl: fetchImpl,
      minBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const events: VaultChangeEvent[] = [];
    const unsubscribe = client.subscribe({
      prefix: '_BAC/',
      onEvent: (event) => events.push(event),
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    unsubscribe();
    await client.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.relPath)).toEqual(['_BAC/r']);
  });
});
