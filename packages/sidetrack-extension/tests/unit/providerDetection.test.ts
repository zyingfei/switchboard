import { describe, expect, it } from 'vitest';

import {
  detectProviderFromUrl,
  isLikelyCaptureUrl,
  isProviderThreadUrl,
} from '../../src/capture/providerDetection';

describe('provider detection', () => {
  it('detects first-party chat providers by URL', () => {
    expect(detectProviderFromUrl('https://chatgpt.com/c/abc')).toBe('chatgpt');
    expect(detectProviderFromUrl('https://chat.openai.com/c/abc')).toBe('chatgpt');
    expect(detectProviderFromUrl('https://claude.ai/chat/abc')).toBe('claude');
    expect(detectProviderFromUrl('https://gemini.google.com/app/abc')).toBe('gemini');
  });

  it('detects browser fixture providers through query params', () => {
    expect(detectProviderFromUrl('http://127.0.0.1:4321/chatgpt.html?provider=chatgpt')).toBe(
      'chatgpt',
    );
    expect(detectProviderFromUrl('http://127.0.0.1:4321/claude.html?provider=claude')).toBe(
      'claude',
    );
    expect(detectProviderFromUrl('http://127.0.0.1:4321/gemini.html?provider=gemini')).toBe(
      'gemini',
    );
  });

  it('allows localhost fixtures while keeping unknown public pages explicit', () => {
    expect(isLikelyCaptureUrl('http://127.0.0.1:4321/fixture.html')).toBe(true);
    expect(isLikelyCaptureUrl('https://example.com/article')).toBe(false);
    expect(detectProviderFromUrl('https://example.com/article')).toBe('unknown');
  });

  // Regression: navigating to non-chat pages on a known provider host
  // (e.g. claude.ai/code, chatgpt.com root, gemini.google.com/app
  // landing) used to trigger auto-capture and create junk thread rows.
  // isProviderThreadUrl rejects those.
  describe('isProviderThreadUrl', () => {
    it('accepts canonical chat-thread URLs for each provider', () => {
      expect(isProviderThreadUrl('chatgpt', 'https://chatgpt.com/c/abc-123')).toBe(true);
      expect(isProviderThreadUrl('chatgpt', 'https://chatgpt.com/g/g-foo/c/abc-123')).toBe(true);
      expect(isProviderThreadUrl('claude', 'https://claude.ai/chat/abc-123')).toBe(true);
      expect(isProviderThreadUrl('gemini', 'https://gemini.google.com/app/abc-123')).toBe(true);
    });

    it('rejects non-chat pages on known-provider hosts', () => {
      expect(isProviderThreadUrl('claude', 'https://claude.ai/')).toBe(false);
      expect(isProviderThreadUrl('claude', 'https://claude.ai/code')).toBe(false);
      expect(isProviderThreadUrl('claude', 'https://claude.ai/login')).toBe(false);
      expect(isProviderThreadUrl('claude', 'https://claude.ai/settings/profile')).toBe(false);
      expect(isProviderThreadUrl('chatgpt', 'https://chatgpt.com/')).toBe(false);
      expect(isProviderThreadUrl('chatgpt', 'https://chatgpt.com/gpts')).toBe(false);
      expect(isProviderThreadUrl('gemini', 'https://gemini.google.com/app')).toBe(false);
      expect(isProviderThreadUrl('gemini', 'https://gemini.google.com/')).toBe(false);
    });

    it('rejects unknown providers and malformed URLs', () => {
      expect(isProviderThreadUrl('unknown', 'https://example.com/article')).toBe(false);
      expect(isProviderThreadUrl('claude', 'not a url')).toBe(false);
    });
  });
});
