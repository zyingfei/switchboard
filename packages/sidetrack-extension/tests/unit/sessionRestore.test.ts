import { describe, expect, it } from 'vitest';

import {
  findSessionRestoreMatch,
  type ClosedSession,
} from '../../src/sidepanel/tabsession/sessionRestore';

const closedTab = (
  sessionId: string,
  url: string,
  title?: string,
): ClosedSession => ({ tab: { sessionId, url, ...(title === undefined ? {} : { title }) } });

describe('findSessionRestoreMatch — restore_session strategy derivation', () => {
  it('matches a closed tab by URL and returns its sessionId', () => {
    const match = findSessionRestoreMatch(
      [closedTab('s1', 'https://chatgpt.com/c/abc')],
      { url: 'https://chatgpt.com/c/abc' },
    );
    expect(match).toEqual({ sessionId: 's1', matchedOn: 'url' });
  });

  it('returns null when no closed session matches the URL', () => {
    const match = findSessionRestoreMatch(
      [closedTab('s1', 'https://chatgpt.com/c/other')],
      { url: 'https://chatgpt.com/c/abc' },
    );
    expect(match).toBeNull();
  });

  it('ignores the URL hash when matching', () => {
    const match = findSessionRestoreMatch(
      [closedTab('s1', 'https://claude.ai/chat/xyz#section')],
      { url: 'https://claude.ai/chat/xyz' },
    );
    expect(match?.sessionId).toBe('s1');
  });

  it('treats a trailing slash as equivalent', () => {
    const match = findSessionRestoreMatch(
      [closedTab('s1', 'https://claude.ai/chat/xyz/')],
      { url: 'https://claude.ai/chat/xyz' },
    );
    expect(match?.sessionId).toBe('s1');
  });

  it('prefers a url+title match over a url-only match', () => {
    const sessions: readonly ClosedSession[] = [
      closedTab('url-only', 'https://chatgpt.com/c/abc', 'A different title'),
      closedTab('url-title', 'https://chatgpt.com/c/abc', 'The Chat Title'),
    ];
    const match = findSessionRestoreMatch(sessions, {
      url: 'https://chatgpt.com/c/abc',
      title: 'The Chat Title',
    });
    expect(match).toEqual({ sessionId: 'url-title', matchedOn: 'url+title' });
  });

  it('reads tabs inside a closed window', () => {
    const sessions: readonly ClosedSession[] = [
      {
        window: {
          tabs: [
            { sessionId: 'w-t1', url: 'https://example.com' },
            { sessionId: 'w-t2', url: 'https://claude.ai/chat/xyz' },
          ],
        },
      },
    ];
    const match = findSessionRestoreMatch(sessions, { url: 'https://claude.ai/chat/xyz' });
    expect(match?.sessionId).toBe('w-t2');
  });

  it('skips tabs that carry no sessionId', () => {
    const sessions: readonly ClosedSession[] = [
      { tab: { url: 'https://chatgpt.com/c/abc' } },
    ];
    expect(findSessionRestoreMatch(sessions, { url: 'https://chatgpt.com/c/abc' })).toBeNull();
  });

  it('returns null for a blank target URL', () => {
    expect(findSessionRestoreMatch([closedTab('s1', 'https://x.com')], { url: '   ' })).toBeNull();
  });
});
