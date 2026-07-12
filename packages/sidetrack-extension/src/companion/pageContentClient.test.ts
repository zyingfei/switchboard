import { webcrypto } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPageContentClient } from './pageContentClient';

// jsdom implements crypto.getRandomValues but not SubtleCrypto; the
// client (and this test's expected-value helper) need digest(), so
// fall back to Node's webcrypto when the environment lacks it.
beforeAll(() => {
  if (typeof globalThis.crypto.subtle?.digest !== 'function') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

interface RecordedFetch {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const stubFetch = (): RecordedFetch[] => {
  const calls: RecordedFetch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve(
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
};

const basePayload = {
  payloadVersion: 1,
  servedContextId: 'ctx-1',
  entityId: 'url:abc123',
  actionAt: '2026-07-10T00:00:00.000Z',
} as const;

describe('PageContentClient.recallAction idempotency fingerprint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the legacy fingerprint byte-for-byte when referencesEventId is absent (engagement clicks)', async () => {
    const calls = stubFetch();
    const client = createPageContentClient({ port: 17374, bridgeKey: 'k' });
    await client.recallAction({ ...basePayload, actionKind: 'click' });
    const expected = `recall-action-${(await sha256Hex('ctx-1:url:abc123:click')).slice(0, 40)}`;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['idempotency-key']).toBe(expected);
  });

  it('folds referencesEventId into the fingerprint when present', async () => {
    const calls = stubFetch();
    const client = createPageContentClient({ port: 17374, bridgeKey: 'k' });
    await client.recallAction({
      ...basePayload,
      actionKind: 'flow_confirm',
      referencesEventId: 'feedback-feedback-user_flow_confirmed-1',
    });
    const expected = `recall-action-${(
      await sha256Hex('ctx-1:url:abc123:flow_confirm:feedback-feedback-user_flow_confirmed-1')
    ).slice(0, 40)}`;
    expect(calls[0]?.headers['idempotency-key']).toBe(expected);
  });

  it('gives repeat gestures (distinct referencesEventId, same served triple) distinct keys', async () => {
    const calls = stubFetch();
    const client = createPageContentClient({ port: 17374, bridgeKey: 'k' });
    await client.recallAction({
      ...basePayload,
      actionKind: 'flow_confirm',
      referencesEventId: 'ref-gesture-1',
    });
    await client.recallAction({
      ...basePayload,
      actionKind: 'flow_confirm',
      referencesEventId: 'ref-gesture-2',
    });
    // A third with no reference must ALSO differ from both — and match
    // the legacy shape, so engagement clicks are untouched.
    await client.recallAction({ ...basePayload, actionKind: 'flow_confirm' });
    const keys = calls.map((call) => call.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(
      `recall-action-${(await sha256Hex('ctx-1:url:abc123:flow_confirm')).slice(0, 40)}`,
    );
  });
});
