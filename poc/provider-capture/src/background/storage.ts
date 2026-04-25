import { normalizeProviderCapture, type ProviderCapture } from '../capture/model';

const capturesKey = 'bac.providerCapture.captures';

const captureThreadKey = (capture: ProviderCapture): string => `${capture.provider}:${capture.url}`;

export const readCaptures = async (): Promise<ProviderCapture[]> => {
  const result = await chrome.storage.local.get(capturesKey);
  const captures = result[capturesKey];
  if (!Array.isArray(captures)) {
    return [];
  }

  const normalizedCaptures = captures.map(normalizeProviderCapture);
  if (JSON.stringify(captures) !== JSON.stringify(normalizedCaptures)) {
    await writeCaptures(normalizedCaptures);
  }
  return normalizedCaptures;
};

export const writeCaptures = async (captures: ProviderCapture[]): Promise<void> => {
  await chrome.storage.local.set({ [capturesKey]: captures.map(normalizeProviderCapture) });
};

export const appendCapture = async (capture: ProviderCapture): Promise<ProviderCapture[]> => {
  const normalizedCapture = normalizeProviderCapture(capture);
  const captures = await readCaptures();
  const nextCaptures = [
    normalizedCapture,
    ...captures.filter((item) => captureThreadKey(item) !== captureThreadKey(normalizedCapture)),
  ].slice(0, 30);
  await writeCaptures(nextCaptures);
  return nextCaptures;
};

export const clearCaptures = async (): Promise<void> => {
  await chrome.storage.local.remove(capturesKey);
};
