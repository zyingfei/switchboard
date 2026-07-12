import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { idempotencyKey } from '../../idempotencyKey';
import type { FeedbackEventEnvelope } from '../connections/client';
import {
  maybeEmitTrainableRecallAction,
  maybeEmitTrainableRecallActionForUrlAttribute,
  trainableActionSpecFor,
} from './emitTrainableAction';
import { recordImpression, resetImpressionRegistryForTests } from './impressionRegistry';

// Stub the two chrome APIs the helper touches: storage.local.get for
// the recallEmitTrainableActions kill-switch and runtime.sendMessage
// for the fire-and-forget emit.
const stubChrome = (settings: Record<string, unknown> | undefined): ReturnType<typeof vi.fn> => {
  const send = vi.fn(() => Promise.resolve({ ok: true }));
  globalThis.chrome = {
    runtime: { sendMessage: send },
    storage: {
      local: {
        get: vi.fn(() =>
          Promise.resolve(settings === undefined ? {} : { 'sidetrack.settings': settings }),
        ),
      },
    },
  } as unknown as typeof chrome;
  return send;
};

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const flowConfirmed: FeedbackEventEnvelope = {
  type: 'user.flow.confirmed',
  payload: {
    payloadVersion: 1,
    relationKind: 'visit_resembles_visit',
    fromId: 'visit:anchor',
    toId: 'visit:target',
  },
};

describe('trainableActionSpecFor', () => {
  // Mapping table mirrors the companion's historicalFeedbackSpecFor
  // (retrain-impressions.ts): subject = that reconstructor's
  // targetEntityId for the same event.
  it('maps user.flow.confirmed → flow_confirm on payload.toId', () => {
    expect(trainableActionSpecFor(flowConfirmed)).toEqual({
      actionKind: 'flow_confirm',
      subjectId: 'visit:target',
    });
  });

  it('maps user.flow.rejected → flow_reject on payload.toId', () => {
    expect(
      trainableActionSpecFor({
        type: 'user.flow.rejected',
        payload: {
          payloadVersion: 1,
          relationKind: 'closest_visit',
          fromId: 'visit:anchor',
          toId: 'visit:bad',
          reason: 'not-related',
        },
      }),
    ).toEqual({ actionKind: 'flow_reject', subjectId: 'visit:bad' });
  });

  it('maps user.snippet.promoted → snippet_promote on payload.targetId', () => {
    expect(
      trainableActionSpecFor({
        type: 'user.snippet.promoted',
        payload: {
          payloadVersion: 1,
          snippetId: 'snippet:1',
          targetKind: 'source',
          targetId: 'visit:src',
          sourceVisitId: 'visit:src',
        },
      }),
    ).toEqual({ actionKind: 'snippet_promote', subjectId: 'visit:src' });
  });

  it.each(['move', 'promote', 'ignore'] as const)(
    'maps user.organized.item action=%s → that kind on payload.itemId',
    (action) => {
      expect(
        trainableActionSpecFor({
          type: 'user.organized.item',
          payload: {
            payloadVersion: 1,
            itemKind: 'visit',
            itemId: 'timeline-visit:https://x.example/p',
            action,
          },
        }),
      ).toEqual({ actionKind: action, subjectId: 'timeline-visit:https://x.example/p' });
    },
  );

  it.each(['rename', 'merge', 'split'] as const)(
    'user.organized.item action=%s is NOT trainable (no-op)',
    (action) => {
      expect(
        trainableActionSpecFor({
          type: 'user.organized.item',
          payload: { payloadVersion: 1, itemKind: 'topic', itemId: 'topic:a', action },
        }),
      ).toBeNull();
    },
  );

  it('other event types are no-ops', () => {
    expect(
      trainableActionSpecFor({
        type: 'user.topic.renamed',
        payload: {
          payloadVersion: 1,
          topicId: 'topic:a',
          previousName: 'A',
          newName: 'B',
          source: 'inline',
        },
      }),
    ).toBeNull();
    expect(
      trainableActionSpecFor({
        type: 'user.engagement.relabeled',
        payload: {
          payloadVersion: 1,
          visitId: 'visit:a',
          fromClass: 'skimmed',
          toClass: 'engaged_read',
        },
      }),
    ).toBeNull();
  });
});

describe('maybeEmitTrainableRecallAction', () => {
  beforeEach(() => {
    resetImpressionRegistryForTests();
  });
  afterEach(() => {
    resetImpressionRegistryForTests();
    // @ts-expect-error — restore default
    delete globalThis.chrome;
  });

  it('emits the exact recallActionEmit payload on a registry hit (incl. referencesEventId)', async () => {
    const send = stubChrome(undefined);
    recordImpression('ctx-77', [{ entityId: 'visit:target' }]);
    maybeEmitTrainableRecallAction(flowConfirmed, 'feedback-user.flow.confirmed-abc');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send).toHaveBeenCalledWith({
      type: 'sidetrack.recall.v2.action',
      payload: {
        payloadVersion: 1,
        servedContextId: 'ctx-77',
        entityId: 'visit:target',
        actionKind: 'flow_confirm',
        actionAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        // NOT the raw sidepanel id: the companion stores the POST's
        // idempotency-key HEADER as the feedback event's clientEventId,
        // so the emitted reference must carry the same transform.
        referencesEventId: idempotencyKey('feedback', 'feedback-user.flow.confirmed-abc'),
      },
    });
  });

  it('referencesEventId string-equals the idempotency-key header postConnectionsFeedbackHttp sends', async () => {
    const send = stubChrome(undefined);
    recordImpression('ctx-hdr', [{ entityId: 'visit:target' }]);
    const clientEventId = 'feedback-user.flow.confirmed-1a2b3c';
    maybeEmitTrainableRecallAction(flowConfirmed, clientEventId);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const emitted = (
      send.mock.calls[0][0] as { readonly payload: { readonly referencesEventId: string } }
    ).payload.referencesEventId;
    // background.ts postConnectionsFeedbackHttp sends header
    // idempotency-key = idempotencyKey('feedback', clientEventId) via
    // the SAME shared helper imported here, and the companion stores
    // that header as the accepted event's clientEventId
    // (server.ts /v1/feedback/events). The trainer dedupe
    // (retrain-impressions.ts referencedFeedbackEventIds) matches by
    // exact string equality against it.
    expect(emitted).toBe(idempotencyKey('feedback', clientEventId));
    // Pin the double-prefix + sanitize behavior byte-exact so a future
    // "simplification" of either side breaks loudly.
    expect(emitted).toBe('feedback-feedback-user_flow_confirmed-1a2b3c');
  });

  it('bridges timeline-visit: subjects to the served entityId via canonicalUrl (real /v2 shapes)', async () => {
    const send = stubChrome(undefined);
    // Served /v2 entityIds look like 'url:<sha24>' — the gesture
    // subject is the graph-node id 'timeline-visit:<canonicalUrl>'.
    recordImpression('ctx-ns', [
      { entityId: 'url:abc123', canonicalUrl: 'https://ex.com/page' },
    ]);
    maybeEmitTrainableRecallAction(
      {
        type: 'user.flow.confirmed',
        payload: {
          payloadVersion: 1,
          relationKind: 'visit_resembles_visit',
          fromId: 'timeline-visit:https://ex.com/anchor',
          toId: 'timeline-visit:https://ex.com/page',
        },
      },
      'feedback-user.flow.confirmed-ns1',
    );
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const message = send.mock.calls[0][0] as {
      readonly payload: { readonly entityId: string; readonly servedContextId: string };
    };
    expect(message.payload.entityId).toBe('url:abc123');
    expect(message.payload.servedContextId).toBe('ctx-ns');
  });

  it('falls back to the URL index when the subject is a bare URL, and emits the SERVED entityId', async () => {
    const send = stubChrome(undefined);
    // Served under a different id namespace + trailing-slash drift —
    // the emitted entityId must be the served one, byte-exact, never
    // the subject string.
    recordImpression('ctx-url', [
      { entityId: 'timeline-visit:https://x.example/p/', canonicalUrl: 'https://x.example/p/' },
    ]);
    maybeEmitTrainableRecallAction(
      {
        type: 'user.organized.item',
        payload: {
          payloadVersion: 1,
          itemKind: 'visit',
          itemId: 'https://x.example/p',
          action: 'move',
          toContainer: 'workstream:w1',
        },
      },
      'feedback-user.organized.item-xyz',
    );
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const message = send.mock.calls[0][0] as {
      readonly payload: { readonly entityId: string; readonly actionKind: string };
    };
    expect(message.payload.entityId).toBe('timeline-visit:https://x.example/p/');
    expect(message.payload.actionKind).toBe('move');
  });

  it('does nothing on a registry miss (the common case) — not even a storage read', async () => {
    const send = stubChrome(undefined);
    maybeEmitTrainableRecallAction(flowConfirmed, 'feedback-user.flow.confirmed-abc');
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(globalThis.chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('does nothing for non-trainable envelopes even when the registry would hit', async () => {
    const send = stubChrome(undefined);
    recordImpression('ctx-1', [{ entityId: 'topic:a' }]);
    maybeEmitTrainableRecallAction(
      {
        type: 'user.organized.item',
        payload: { payloadVersion: 1, itemKind: 'topic', itemId: 'topic:a', action: 'rename' },
      },
      'feedback-user.organized.item-rename',
    );
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('is silenced by recallEmitTrainableActions=false (kill-switch)', async () => {
    const send = stubChrome({ recallEmitTrainableActions: false });
    recordImpression('ctx-77', [{ entityId: 'visit:target' }]);
    maybeEmitTrainableRecallAction(flowConfirmed, 'feedback-user.flow.confirmed-abc');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('defaults ON when the flag is absent from stored settings', async () => {
    const send = stubChrome({ captureEnabled: true });
    recordImpression('ctx-77', [{ entityId: 'visit:target' }]);
    maybeEmitTrainableRecallAction(flowConfirmed, 'feedback-user.flow.confirmed-abc');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('swallows sendMessage failures (fire-and-forget)', async () => {
    stubChrome(undefined);
    const send = vi.fn(() => Promise.reject(new Error('SW restarting')));
    (globalThis.chrome.runtime as { sendMessage: unknown }).sendMessage = send;
    recordImpression('ctx-77', [{ entityId: 'visit:target' }]);
    expect(() => {
      maybeEmitTrainableRecallAction(flowConfirmed, 'feedback-user.flow.confirmed-abc');
    }).not.toThrow();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('maybeEmitTrainableRecallActionForUrlAttribute', () => {
  beforeEach(() => {
    resetImpressionRegistryForTests();
  });
  afterEach(() => {
    resetImpressionRegistryForTests();
    // @ts-expect-error — restore default
    delete globalThis.chrome;
  });

  it("emits actionKind 'move' with the attribute header VERBATIM as referencesEventId", async () => {
    const send = stubChrome(undefined);
    recordImpression('ctx-attr', [{ entityId: 'url:abc123', canonicalUrl: 'https://ex.com/page' }]);
    // The /v1/visits/:url/attribute route stores its idempotency-key
    // header verbatim (no 'feedback-' re-prefix), so the reference is
    // the raw header string.
    maybeEmitTrainableRecallActionForUrlAttribute('https://ex.com/page', 'url-hdr_exact_value');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send).toHaveBeenCalledWith({
      type: 'sidetrack.recall.v2.action',
      payload: {
        payloadVersion: 1,
        servedContextId: 'ctx-attr',
        entityId: 'url:abc123',
        actionKind: 'move',
        actionAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        referencesEventId: 'url-hdr_exact_value',
      },
    });
  });

  it('does nothing when the attributed URL was never recall-served', async () => {
    const send = stubChrome(undefined);
    maybeEmitTrainableRecallActionForUrlAttribute('https://never.example/p', 'url-hdr');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('is silenced by recallEmitTrainableActions=false (same kill-switch)', async () => {
    const send = stubChrome({ recallEmitTrainableActions: false });
    recordImpression('ctx-attr', [{ entityId: 'url:abc123', canonicalUrl: 'https://ex.com/page' }]);
    maybeEmitTrainableRecallActionForUrlAttribute('https://ex.com/page', 'url-hdr');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});
