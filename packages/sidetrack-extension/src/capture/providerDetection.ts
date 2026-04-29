import type { ProviderId } from '../companion/model';

const fixtureProviders = new Set<ProviderId>(['chatgpt', 'claude', 'gemini']);

const providerFromFixtureParam = (url: URL): ProviderId | null => {
  const provider = url.searchParams.get('provider') as ProviderId | null;
  return provider !== null && fixtureProviders.has(provider) ? provider : null;
};

export const detectProviderFromUrl = (inputUrl: string): ProviderId => {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return 'unknown';
  }

  const fixtureProvider = providerFromFixtureParam(url);
  if (fixtureProvider !== null) {
    return fixtureProvider;
  }

  const host = url.hostname.toLowerCase();
  if (host === 'chatgpt.com' || host === 'chat.openai.com') {
    return 'chatgpt';
  }
  if (host === 'claude.ai') {
    return 'claude';
  }
  if (host === 'gemini.google.com') {
    return 'gemini';
  }
  return 'unknown';
};

export const isSupportedProvider = (provider: ProviderId): boolean => provider !== 'unknown';

export const isLikelyCaptureUrl = (inputUrl: string): boolean => {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return false;
  }

  if (detectProviderFromUrl(inputUrl) !== 'unknown') {
    return true;
  }

  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
};

// Validates that a URL matches the provider's actual chat-thread shape,
// not just its hostname. Used to gate auto-capture and explicit-capture
// requests so we don't create thread records for non-chat URLs (e.g.
// claude.ai/code, chatgpt.com root, gemini.google.com/app landing).
export const isProviderThreadUrl = (provider: ProviderId, inputUrl: string): boolean => {
  if (provider === 'unknown') {
    // Generic-fallback / 127.0.0.1 / localhost never qualify as a
    // *known-provider* thread URL — caller should explicitly handle the
    // generic-track flow if it wants to record those.
    return false;
  }
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return false;
  }
  // Fixture-server URLs that carry an explicit ?provider= override
  // qualify as long as the path looks chat-shaped.
  const pathname = url.pathname;
  switch (provider) {
    case 'chatgpt':
      // /c/<threadId> or /g/<gptId>/c/<threadId>
      return /\/(?:c|g\/[^/]+\/c)\/[^/?#]+/u.test(pathname);
    case 'claude':
      // /chat/<threadId>
      return /\/chat\/[^/?#]+/u.test(pathname);
    case 'gemini':
      // /app/<threadId> — bare /app is the new-chat landing.
      return /\/app\/[^/?#]+/u.test(pathname);
  }
};
