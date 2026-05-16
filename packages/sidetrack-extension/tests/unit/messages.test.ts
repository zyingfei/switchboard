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

  it('accepts deja-vu focus requests with synthetic row metadata', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.focusThreadInSidePanel,
        threadUrl: 'https://gemini.google.com/app/thread',
        bacId: 'bac_thread_recalled',
        title: 'Recalled thread',
        lastSeenAt: '2026-05-13T19:41:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts deja-vu focus requests with bac_id only', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.focusThreadInSidePanel,
        bacId: 'bac_thread_recalled',
        title: 'Recalled thread',
      }),
    ).toBe(true);
  });

  it('rejects deja-vu focus requests without a URL or bac_id', () => {
    expect(
      isRuntimeRequest({
        type: messageTypes.focusThreadInSidePanel,
        title: 'No target',
      }),
    ).toBe(false);
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
});
