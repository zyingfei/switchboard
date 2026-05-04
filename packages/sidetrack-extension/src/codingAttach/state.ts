import type { CodingSurface } from './detection';

const STORAGE_KEY = 'sidetrack.codingAttach.offers';
const OFFER_TTL_MS = 30 * 60 * 1000;

export interface OfferRecord {
  readonly tabId: number;
  readonly url: string;
  readonly surface: CodingSurface;
  readonly offeredAt: string;
  readonly status: 'pending' | 'accepted' | 'declined' | 'expired';
}

const readOffers = async (): Promise<readonly OfferRecord[]> => {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  return Array.isArray(value)
    ? value.filter((item): item is OfferRecord => typeof item === 'object' && item !== null)
    : [];
};

const writeOffers = async (offers: readonly OfferRecord[]): Promise<void> => {
  await chrome.storage.local.set({ [STORAGE_KEY]: offers });
};

const expire = (offers: readonly OfferRecord[], now: Date): readonly OfferRecord[] =>
  offers.map((offer) =>
    offer.status === 'pending' && now.getTime() - Date.parse(offer.offeredAt) > OFFER_TTL_MS
      ? { ...offer, status: 'expired' }
      : offer,
  );

export const upsertOffer = async (
  input: Omit<OfferRecord, 'offeredAt' | 'status'>,
  now: Date = new Date(),
): Promise<OfferRecord> => {
  const offer: OfferRecord = { ...input, offeredAt: now.toISOString(), status: 'pending' };
  const existing = expire(await readOffers(), now).filter((item) => item.tabId !== input.tabId);
  await writeOffers([...existing, offer]);
  return offer;
};

export const listPendingOffers = async (now: Date = new Date()): Promise<readonly OfferRecord[]> => {
  const offers = expire(await readOffers(), now);
  await writeOffers(offers);
  return offers.filter((offer) => offer.status === 'pending');
};

export const markStatus = async (
  tabId: number,
  status: OfferRecord['status'],
): Promise<OfferRecord | null> => {
  let updated: OfferRecord | null = null;
  const offers = (await readOffers()).map((offer) => {
    if (offer.tabId !== tabId) {
      return offer;
    }
    updated = { ...offer, status };
    return updated;
  });
  await writeOffers(offers);
  return updated;
};
