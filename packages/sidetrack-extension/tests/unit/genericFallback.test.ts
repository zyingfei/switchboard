import { describe, expect, it } from 'vitest';

import { captureGenericTab } from '../../src/capture/genericFallback';

describe('generic tab fallback capture', () => {
  it('creates a metadata-only capture event for arbitrary URLs', () => {
    const event = captureGenericTab(
      {
        url: 'https://github.com/zyingfei/switchboard/pull/13',
        title: 'M1 PR',
      },
      '2026-04-26T21:30:00.000Z',
    );

    expect(event).toEqual({
      provider: 'unknown',
      threadUrl: 'https://github.com/zyingfei/switchboard/pull/13',
      title: 'M1 PR',
      capturedAt: '2026-04-26T21:30:00.000Z',
      selectorCanary: 'warning',
      turns: [],
    });
  });
});
