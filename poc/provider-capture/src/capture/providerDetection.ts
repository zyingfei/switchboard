import type { ProviderId } from './model';

const fixtureProviders = new Set<ProviderId>(['chatgpt', 'claude', 'gemini']);

const providerFromFixtureParam = (url: URL): ProviderId | null => {
  const provider = url.searchParams.get('provider') as ProviderId | null;
  return provider && fixtureProviders.has(provider) ? provider : null;
};

export const detectProviderFromUrl = (inputUrl: string): ProviderId => {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return 'unknown';
  }

  const fixtureProvider = providerFromFixtureParam(url);
  if (fixtureProvider) {
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
