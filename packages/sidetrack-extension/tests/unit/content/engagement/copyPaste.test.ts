import { describe, expect, it, vi } from 'vitest';

import { attachCopyPasteLineage } from '../../../../src/content/engagement/copy-paste';

// attachCopyPasteLineage hashes the selection via crypto.subtle.digest — a
// real (not synchronously-resolved) WebCrypto call, so how many event-loop
// ticks it takes to settle is not fixed. A bounded FLUSH-COUNT loop (the
// prior approach: 5x setTimeout(0)+microtask) flaked on CI once because it
// bounds elapsed *ticks*, not elapsed *time* — under a contended runner each
// tick can itself take longer than the digest needs, so 5 ticks stop being
// "plenty of margin". Poll on a wall-clock deadline instead: deterministic
// intent (stop as soon as both messages land) with a generous real-time
// budget as the honest upper bound, not a papered-over retry.
const waitUntil = async (
  predicate: () => boolean,
  { timeoutMs = 2_000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
    await waitUntil(() => sent.length >= 2);

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
