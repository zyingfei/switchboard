// A chat thread is BOTH a tab-session and a URL. Attributing it via the
// side panel's Current-tab card writes a URL attribution (urlProjection
// + USER_ORGANIZED_ITEM itemKind:'canonical-url'), but projectTabSessions
// folds only tab-session events — so All-threads / the tab-session inbox
// / resolveTabSessionAttribution kept treating an already-filed chat as
// unattributed and re-asked the user to pick a workstream.
//
// Read-time overlay (no event-model change, reversible): a tab-session
// with no own attribution inherits its latestUrl's URL attribution, so
// every tab-session consumer agrees with the Current-tab card. Applied
// at the single loadTabSessionProjection seam → consistent everywhere.

import type { UrlAttribution, UrlProjection } from '../urls/projection.js';
import type { TabSessionAttribution, TabSessionProjection } from './projection.js';

const URL_TO_TAB_SOURCE: Record<UrlAttribution['source'], TabSessionAttribution['source']> = {
  user_asserted: 'user_asserted',
  'tab-group-pull-in': 'tab-group-pull-in',
  'tab-group-pull-out': 'tab-group-pull-out',
  inferred: 'inferred',
  // UrlAttribution has a 'thread' source (companion-derived); the
  // tab-session model has no equivalent — treat it as inferred.
  thread: 'inferred',
};

export const overlayUrlAttributionOntoTabSessions = (
  tab: TabSessionProjection,
  url: UrlProjection,
): TabSessionProjection => {
  let changed = false;
  const next = new Map(tab.bySessionId);
  for (const [id, record] of tab.bySessionId) {
    if (record.currentAttribution !== undefined) continue;
    if (record.latestUrl === undefined) continue;
    const attribution = url.byCanonicalUrl.get(record.latestUrl)?.currentAttribution;
    if (attribution === undefined) continue;
    next.set(id, {
      ...record,
      currentAttribution: {
        workstreamId: attribution.workstreamId,
        source: URL_TO_TAB_SOURCE[attribution.source] ?? 'inferred',
        observedAt: attribution.observedAt,
        clientEventId: attribution.clientEventId,
        replicaId: attribution.replicaId,
        seq: attribution.seq,
      },
    });
    changed = true;
  }
  return changed ? { ...tab, bySessionId: next } : tab;
};
