export const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const compactIso = (iso: string): string => iso.replace(/[^0-9]/g, '').slice(0, 14);

export const createCaptureId = (provider: string, capturedAt: string, seed: string): string =>
  `capture-${provider}-${compactIso(capturedAt)}-${stableHash(seed).slice(0, 8)}`;
