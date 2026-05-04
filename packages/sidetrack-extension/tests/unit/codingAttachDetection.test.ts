import { describe, expect, it } from 'vitest';

import { detectCodingSurface } from '../../src/codingAttach/detection';

const doc = (text: string): Document => {
  document.body.innerHTML = `<main>${text}</main>`;
  return document;
};

describe('coding attach detection', () => {
  it('detects Codex URL and DOM hints with high confidence', () => {
    expect(detectCodingSurface('https://chatgpt.com/codex/project', doc('Codex diff branch'))).toEqual({
      id: 'codex',
      signals: { urlMatch: true, domHint: true },
      confidence: 'high',
    });
  });

  it('uses medium confidence for URL-only matches and low for DOM-only matches', () => {
    expect(detectCodingSurface('https://claude.ai/code/session', doc('ordinary page'))).toMatchObject({
      id: 'claude_code',
      confidence: 'medium',
    });
    expect(detectCodingSurface('https://example.test/page', doc('Cursor agent cloud'))).toMatchObject({
      id: 'cursor',
      confidence: 'low',
    });
  });

  it('returns null when no surface signals match', () => {
    expect(detectCodingSurface('https://example.test/page', doc('plain article'))).toBeNull();
  });
});
