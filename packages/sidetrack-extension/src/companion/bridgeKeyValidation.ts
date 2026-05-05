const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type BridgeKeyValidationFailure = 'missing' | 'malformed' | 'rejected';

export const bridgeKeyValidationCopy: Record<BridgeKeyValidationFailure, string> = {
  missing: 'Bridge key missing — paste the line from _BAC/.config/bridge.key before connecting.',
  malformed: 'Bridge key malformed — copy the full single line from _BAC/.config/bridge.key.',
  rejected:
    'Bridge key rejected — this companion is running with a different vault key. Copy the key from the companion output or _BAC/.config/bridge.key.',
};

export const validateBridgeKeyCandidate = (
  bridgeKey: string,
): Exclude<BridgeKeyValidationFailure, 'rejected'> | null => {
  const trimmed = bridgeKey.trim();
  if (trimmed.length === 0) {
    return 'missing';
  }
  if (trimmed.length < 32 || !BASE64URL_PATTERN.test(trimmed)) {
    return 'malformed';
  }
  return null;
};
