import { describe, expect, it, vi } from 'vitest';

import { attachCopyPasteLineage } from '../../../../src/content/engagement/copy-paste';

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

describe('copy/paste lineage content helper', () => {
  it('emits hash-only copy and paste messages', async () => {
    const sent: unknown[] = [];
    attachCopyPasteLineage({
      visitId: 'visit:one',
      send: (message) => {
        sent.push(message);
      },
      location: {
        hostname: 'chatgpt.com',
        pathname: '/c/abc',
        href: 'https://chatgpt.com/c/abc#frag',
        search: '',
      },
      selection: () => ({ toString: () => 'hello copied text' }) as Selection,
    });

    document.dispatchEvent(new Event('copy'));
    const paste = new Event('paste') as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: vi.fn(() => 'hello copied text') },
      configurable: true,
    });
    document.dispatchEvent(paste);
    for (let i = 0; i < 5 && sent.length < 2; i += 1) await flush();

    const [copy, pasted] = sent as Array<{
      readonly type: string;
      readonly payload: {
        readonly selectionHash: string;
        readonly rawTextStored: false;
        readonly destinationKind?: string;
        readonly destinationId?: string;
      };
    }>;
    expect(copy?.type).toBe('sidetrack.selection.copied');
    expect(pasted?.type).toBe('sidetrack.selection.pasted');
    expect(copy?.payload.selectionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(pasted?.payload.selectionHash).toBe(copy?.payload.selectionHash);
    expect(copy?.payload.rawTextStored).toBe(false);
    expect(pasted?.payload.rawTextStored).toBe(false);
    expect(pasted?.payload.destinationKind).toBe('thread');
    expect(pasted?.payload.destinationId).toBe('https://chatgpt.com/c/abc');
  });
});
