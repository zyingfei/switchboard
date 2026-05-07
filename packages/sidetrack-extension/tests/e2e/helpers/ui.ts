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
  | 'captures-queued'
  | 'captures-failed'
  | 'vault-unreachable'
  | 'provider-broken';

const BANNER_TITLE_PREFIX: Record<BannerKind, string> = {
  'companion-disconnected': 'Companion: disconnected',
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

// ---- conflict UI (for T6.4) ----
//
// At plan time there is NO conflict-rendering UI in
// entrypoints/sidepanel/. This matcher is the contract the side
// panel must satisfy when conflict surfaces ship — it looks for
// either an explicit `.conflict` styling on a draft slot, or an
// element labelled with both candidate values + an `aria-label`
// containing "conflict".

export const conflictForSlot = (page: Page, slotName: 'verdict' | 'overall' | 'comment'): Locator =>
  page.locator(`[data-conflict-slot="${slotName}"]`);

export const expectConflictUi = async (
  page: Page,
  slotName: 'verdict' | 'overall' | 'comment',
): Promise<void> => {
  await expect(conflictForSlot(page, slotName)).toHaveCount(1, { timeout: 10_000 });
};

export const expectResolvedValue = async (
  page: Page,
  slotName: 'verdict' | 'overall' | 'comment',
  value: string,
): Promise<void> => {
  // After resolution, the conflict marker is gone AND the slot
  // shows the chosen value.
  await expectNoConflict(page, slotName);
  // Slot value is rendered inside `[data-slot="<name>"]`. Match the
  // contract; tests will fail loudly if the slot markup ships
  // differently and we'll pin the actual selector here.
  await expect(page.locator(`[data-slot="${slotName}"]`)).toContainText(value, { timeout: 10_000 });
};

const expectNoConflict = async (
  page: Page,
  slotName: 'verdict' | 'overall' | 'comment',
): Promise<void> => {
  await expect(conflictForSlot(page, slotName)).toHaveCount(0, { timeout: 10_000 });
};
