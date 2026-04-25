export type SearchProvider = 'google-search' | 'duckduckgo-search';

export interface SearchProviderConfig {
  id: SearchProvider;
  title: string;
  baseUrl: string;
  queryParam: string;
}

export interface SearchDispatch {
  provider: SearchProvider;
  title: string;
  query: string;
  url: string;
}

export interface SearchObservation {
  provider: SearchProvider;
  title: string;
  query: string;
  requestedUrl: string;
  finalUrl: string;
  tabTitle?: string;
}

export const SEARCH_PROVIDER_CONFIGS: Record<SearchProvider, SearchProviderConfig> = {
  'google-search': {
    id: 'google-search',
    title: 'Google Search',
    baseUrl: 'https://www.google.com/search',
    queryParam: 'q',
  },
  'duckduckgo-search': {
    id: 'duckduckgo-search',
    title: 'DuckDuckGo Search',
    baseUrl: 'https://duckduckgo.com/',
    queryParam: 'q',
  },
};

export const isSearchProvider = (value: string): value is SearchProvider =>
  value === 'google-search' || value === 'duckduckgo-search';

const stripMarkdown = (content: string): string =>
  content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/[#>*_[\]()~!-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

export const buildSearchQuery = (noteContent: string): string => {
  const heading = /^#\s+(.+)$/mu.exec(noteContent)?.[1]?.trim();
  const body = stripMarkdown(noteContent);
  const raw = [heading, body]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .split(/\s+/u)
    .slice(0, 18)
    .join(' ');
  return raw || 'browser ai companion local first workstream switchboard';
};

export const buildSearchUrl = (provider: SearchProvider, query: string): string => {
  const config = SEARCH_PROVIDER_CONFIGS[provider];
  const url = new URL(config.baseUrl);
  url.searchParams.set(config.queryParam, query);
  return url.toString();
};

export const buildSearchDispatch = (
  provider: SearchProvider,
  noteContent: string,
): SearchDispatch => {
  const query = buildSearchQuery(noteContent);
  const config = SEARCH_PROVIDER_CONFIGS[provider];
  return {
    provider,
    title: config.title,
    query,
    url: buildSearchUrl(provider, query),
  };
};

export const buildSearchArtifact = ({
  title,
  query,
  requestedUrl,
  finalUrl,
  tabTitle,
}: SearchObservation): string =>
  [
    `${title} branch artifact`,
    '',
    `Query: ${query}`,
    `Requested URL: ${requestedUrl}`,
    `Final URL: ${finalUrl}`,
    `Observed title: ${tabTitle?.trim() || 'Unavailable'}`,
    '',
    'Observation: tab navigation completed. The POC intentionally does not capture search-result DOM.',
  ].join('\n');
