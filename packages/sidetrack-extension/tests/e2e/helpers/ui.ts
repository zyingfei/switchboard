import { expect, type Locator, type Page } from '@playwright/test';

// Side-panel UI matchers used by Tier 6 tests. Anchored on the
// classnames + visible text in entrypoints/sidepanel/components/
// SystemBanners.tsx and the thread-row renderer in
// entrypoints/sidepanel/App.tsx (`renderThreadRow`).
//
// Stability: these match on classnames + visible text, NOT on
// data-testid (the codebase doesn't use them). If a copy change
// breaks a test, the test is doing its job — pin the new copy
// here in one place.

export const ThreadRowSelector = '.thread';
export const ThreadRowNameSelector = '.thread .name';

// ---- thread rows ----

export const threadRowFor = (page: Page, title: string): Locator =>
  page.locator(ThreadRowSelector).filter({ has: page.locator('.name', { hasText: title }) });

export const expectThreadRowVisible = async (page: Page, title: string): Promise<void> => {
  await expect(threadRowFor(page, title)).toHaveCount(1, { timeout: 10_000 });
};

export const expectNoThreadRow = async (page: Page, title: string): Promise<void> => {
  await expect(threadRowFor(page, title)).toHaveCount(0, { timeout: 5_000 });
};

// ---- system banners ----
//
// Banner classes from SystemBanners.tsx:
//   .sys-banner.sys-red      → companion_disconnected, captures_failed
//   .sys-banner.sys-amber    → captures_queued, vault_unreachable
//   .sys-banner.sys-yellow   → provider_broken
//   .sys-banner.sys-signal   → screen_share_active, injection_detected
//
// We disambiguate red banners by visible title text — companion
// vs failed-captures share a tone but render different copy.

export type BannerKind =
  | 'companion-disconnected'
  | 'relay-disconnected'
  | 'captures-queued'
  | 'captures-failed'
  | 'vault-unreachable'
  | 'provider-broken';

const BANNER_TITLE_PREFIX: Record<BannerKind, string> = {
  'companion-disconnected': 'Companion: disconnected',
  'relay-disconnected': 'Peer sync paused',
  'captures-queued': 'Captures queued',
  'captures-failed': 'Explicit captures failed after retries',
  'vault-unreachable': 'Vault: error',
  'provider-broken': 'Provider extractor:',
};

export const bannerFor = (page: Page, kind: BannerKind): Locator =>
  page
    .locator('.sys-banner')
    .filter({ has: page.locator('.sys-title', { hasText: BANNER_TITLE_PREFIX[kind] }) });

export const expectBanner = async (page: Page, kind: BannerKind): Promise<void> => {
  await expect(bannerFor(page, kind)).toHaveCount(1, { timeout: 10_000 });
};

export const expectNoBanner = async (page: Page, kind: BannerKind): Promise<void> => {
  await expect(bannerFor(page, kind)).toHaveCount(0, { timeout: 5_000 });
};

// captures_queued and captures_failed banners include a count in
// their detail text ("3 pending", "2 unsynced"). This matcher
// extracts the number so the test can assert it decreased.

export const readBannerCount = async (page: Page, kind: BannerKind): Promise<number | null> => {
  const banner = bannerFor(page, kind);
  if ((await banner.count()) === 0) return null;
  const text = (await banner.first().textContent()) ?? '';
  const m = /(\d+)\s*(pending|unsynced)/.exec(text);
  return m ? Number.parseInt(m[1] ?? '0', 10) : null;
};

// ---- conflict UI (for T6.4 / T6.5) ----
//
// Review-draft register conflicts (overall / verdict / per-span
// comment) render through the ConflictBanner subtree in
// entrypoints/sidepanel/components/ReviewDraftFooter.tsx. Markup:
//
//   <div className="review-draft-conflict mono">
//     <span className="review-draft-conflict-label">
//       Verdict has 2 versions:
//     </span>
//     <button className="btn-link review-draft-conflict-pick"
//             title="agree">Use "agree"</button>
//     <button className="btn-link review-draft-conflict-pick"
//             title="partial">Use "partial"</button>
//   </div>
//
// We disambiguate the per-slot banner by the leading label text
// ("Verdict" / "Overall" / "Comment") because the markup itself
// doesn't carry a slot-id attribute.

export type ConflictSlot = 'verdict' | 'overall' | 'comment';

const CONFLICT_LABEL: Record<ConflictSlot, string> = {
  verdict: 'Verdict',
  overall: 'Overall',
  comment: 'Comment',
};

export const conflictForSlot = (page: Page, slot: ConflictSlot): Locator =>
  page.locator('.review-draft-conflict').filter({
    has: page.locator('.review-draft-conflict-label', { hasText: CONFLICT_LABEL[slot] }),
  });

export const expectConflictUi = async (page: Page, slot: ConflictSlot): Promise<void> => {
  await expect(conflictForSlot(page, slot)).toHaveCount(1, { timeout: 10_000 });
};

export const expectNoConflictUi = async (page: Page, slot: ConflictSlot): Promise<void> => {
  await expect(conflictForSlot(page, slot)).toHaveCount(0, { timeout: 10_000 });
};

// Click the "Use <value>" pick button for a specific candidate.
// Matches the button's title attribute, which carries the
// renderValue output. For overall + comment slots this is the raw
// string value; for verdict it's the VERDICT_LABELS-mapped label
// ("Agree" / "Partial" / etc., not "agree" / "partial").
export const pickConflictCandidate = async (
  page: Page,
  slot: ConflictSlot,
  candidateTitle: string,
): Promise<void> => {
  await conflictForSlot(page, slot)
    .locator(`button.review-draft-conflict-pick[title="${candidateTitle}"]`)
    .first()
    .click();
};
