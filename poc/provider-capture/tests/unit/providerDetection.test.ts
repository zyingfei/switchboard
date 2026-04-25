import { describe, expect, it } from 'vitest';
import { detectProviderFromUrl, isLikelyCaptureUrl } from '../../src/capture/providerDetection';

describe('provider detection', () => {
  it('detects first-party chat providers by URL', () => {
    expect(detectProviderFromUrl('https://chatgpt.com/c/abc')).toBe('chatgpt');
    expect(detectProviderFromUrl('https://chat.openai.com/c/abc')).toBe('chatgpt');
    expect(detectProviderFromUrl('https://claude.ai/chat/abc')).toBe('claude');
    expect(detectProviderFromUrl('https://gemini.google.com/app/abc')).toBe('gemini');
  });

  it('detects browser fixture providers through query params', () => {
    expect(detectProviderFromUrl('http://127.0.0.1:4321/chatgpt.html?provider=chatgpt')).toBe('chatgpt');
    expect(detectProviderFromUrl('http://127.0.0.1:4321/claude.html?provider=claude')).toBe('claude');
    expect(detectProviderFromUrl('http://127.0.0.1:4321/gemini.html?provider=gemini')).toBe('gemini');
  });

  it('allows localhost fixtures while keeping unknown public pages explicit', () => {
    expect(isLikelyCaptureUrl('http://127.0.0.1:4321/fixture.html')).toBe(true);
    expect(isLikelyCaptureUrl('https://example.com/article')).toBe(false);
    expect(detectProviderFromUrl('https://example.com/article')).toBe('unknown');
  });
});
