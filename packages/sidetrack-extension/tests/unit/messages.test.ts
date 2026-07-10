import { describe, expect, it } from 'vitest';

import { isRuntimeRequest, messageTypes } from '../../src/messages';

describe('runtime message validation', () => {
  it('accepts publishAnnotationToChat requests', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.publishAnnotationToChat,
        threadUrl: 'https://chatgpt.com/c/thread',
        turnText: 'Assistant turn text',
        turnRole: 'assistant',
        anchorText: 'Assistant',
        note: 'Publish this annotation',
        capturedAt: '2026-05-05T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts keyword-targeted annotateTurn requests', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.annotateTurn,
        threadUrl: 'https://chatgpt.com/c/thread',
        turnText: 'Assistant turn text mentioning WebGPU',
        anchorText: 'WebGPU',
        note: 'WebGPU is the browser GPU API surface.',
        capturedAt: '2026-05-05T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects publishAnnotationToChat requests with invalid roles', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.publishAnnotationToChat,
        threadUrl: 'https://chatgpt.com/c/thread',
        turnText: 'Assistant turn text',
        turnRole: 'moderator',
        note: 'Publish this annotation',
        capturedAt: '2026-05-05T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  // P2 — the See-all handoff items may carry entityId/servedContextId
  // (impression join). Optional (old payloads parse), but when present
  // they must be strings — a non-string would poison the recall.action
  // join downstream.
  it('accepts openConnectionsDejaVu items with and without impression fields', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.openConnectionsDejaVu,
        selectionText: 'query',
        sourceUrl: 'https://example.com/page',
        items: [
          { id: 'cand:1', entityId: 'entity:1', servedContextId: 'ctx-1' },
          { id: 'old-item-without-impression-fields' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects openConnectionsDejaVu items with non-string impression fields', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.openConnectionsDejaVu,
        selectionText: 'query',
        sourceUrl: 'https://example.com/page',
        items: [{ id: 'cand:1', entityId: 42, servedContextId: 'ctx-1' }],
      }),
    ).toBe(false);
    expect(
      isRuntimeRequest({
        type: messageTypes.openConnectionsDejaVu,
        selectionText: 'query',
        sourceUrl: 'https://example.com/page',
        items: [{ id: 'cand:1', servedContextId: { nested: true } }],
      }),
    ).toBe(false);
  });
});
