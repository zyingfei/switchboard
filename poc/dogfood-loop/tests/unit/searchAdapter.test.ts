import { describe, expect, it } from 'vitest';
import {
  buildSearchArtifact,
  buildSearchDispatch,
  buildSearchQuery,
  buildSearchUrl,
} from '../../src/adapters/searchAdapter';

describe('search adapter helpers', () => {
  it('builds a compact query from markdown note content', () => {
    expect(
      buildSearchQuery('# Search Spike\nFind prior art for local-first AI workstream switchboards.\n'),
    ).toBe('Search Spike Search Spike Find prior art for local first AI workstream switchboards.');
  });

  it('creates provider-specific search dispatch URLs', () => {
    const google = buildSearchDispatch('google-search', '# Browser AI\nlocal provenance loop');
    const duckduckgo = buildSearchDispatch('duckduckgo-search', '# Browser AI\nlocal provenance loop');

    expect(google.title).toBe('Google Search');
    expect(google.url).toBe(buildSearchUrl('google-search', google.query));
    expect(google.url).toContain('https://www.google.com/search?q=');
    expect(duckduckgo.title).toBe('DuckDuckGo Search');
    expect(duckduckgo.url).toContain('https://duckduckgo.com/?q=');
  });

  it('produces a no-DOM-capture branch artifact', () => {
    const artifact = buildSearchArtifact({
      provider: 'google-search',
      title: 'Google Search',
      query: 'browser ai companion',
      requestedUrl: 'https://www.google.com/search?q=browser+ai+companion',
      finalUrl: 'https://www.google.com/search?q=browser+ai+companion',
      tabTitle: 'browser ai companion - Google Search',
    });

    expect(artifact).toContain('Google Search branch artifact');
    expect(artifact).toContain('Query: browser ai companion');
    expect(artifact).toContain('does not capture search-result DOM');
  });
});
