import { canonicalizeDomSkeleton, type DomSkeletonNode } from '../../graph/dom-skeleton';

export const VISUAL_FINGERPRINT_OBSERVED = 'visual.fingerprint.observed' as const;
export const VISUAL_FINGERPRINT_MESSAGE = 'sidetrack.visualFingerprint.observed' as const;
export const VISUAL_FINGERPRINT_PRIVACY_GET = 'sidetrack.visualFingerprint.privacy.get' as const;

export interface VisualFingerprintObservedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly domHash: string;
  readonly observedAt: string;
}

export interface VisualFingerprintObservedMessage {
  readonly type: typeof VISUAL_FINGERPRINT_MESSAGE;
  readonly version: 1;
  readonly payload: VisualFingerprintObservedPayload;
}

export interface VisualFingerprintDeps {
  readonly root: Element;
  readonly locationHref: string;
  readonly now: () => Date;
  readonly isPrivacyGateOpen: () => Promise<boolean>;
  readonly send: (message: VisualFingerprintObservedMessage) => void;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (value: string): Promise<string> =>
  bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

export const skeletonFromElement = (element: Element): DomSkeletonNode => ({
  tag: element.localName.toLowerCase(),
  hasId: element.hasAttribute('id'),
  hasClass: element.hasAttribute('class'),
  children: Array.from(element.children, (child) => skeletonFromElement(child)),
});

export const canonicalDomSkeletonForElement = (element: Element): string =>
  canonicalizeDomSkeleton(skeletonFromElement(element));

export const domSkeletonHash = async (element: Element): Promise<string> =>
  sha256Hex(canonicalDomSkeletonForElement(element));

export const visitIdForHref = (href: string): string => {
  try {
    const url = new URL(href);
    url.hash = '';
    return `visit:${url.toString()}`;
  } catch {
    return `visit:${href.replace(/#.*$/u, '')}`;
  }
};

export const isVisualFingerprintObservedPayload = (
  value: unknown,
): value is VisualFingerprintObservedPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (typeof value['visitId'] !== 'string' || value['visitId'].length === 0) return false;
  if (typeof value['domHash'] !== 'string' || !SHA256_HEX_RE.test(value['domHash'])) {
    return false;
  }
  if (typeof value['observedAt'] !== 'string' || value['observedAt'].length > 64) {
    return false;
  }
  if (
    value['pHash'] !== undefined ||
    value['screenshot'] !== undefined ||
    value['contents'] !== undefined ||
    value['dimensions'] !== undefined
  ) {
    return false;
  }
  return true;
};

export const isVisualFingerprintObservedMessage = (
  value: unknown,
): value is VisualFingerprintObservedMessage => {
  if (!isRecord(value)) return false;
  return (
    value['type'] === VISUAL_FINGERPRINT_MESSAGE &&
    value['version'] === 1 &&
    isVisualFingerprintObservedPayload(value['payload'])
  );
};

export const readVisualFingerprintPrivacyGate = async (): Promise<boolean> => {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: VISUAL_FINGERPRINT_PRIVACY_GET,
    })) as unknown;
    if (!isRecord(response)) return false;
    return response['ok'] === true && response['enabled'] === true;
  } catch {
    return false;
  }
};

export const emitVisualFingerprintOnce = async (deps: VisualFingerprintDeps): Promise<boolean> => {
  if (!(await deps.isPrivacyGateOpen())) return false;
  const domHash = await domSkeletonHash(deps.root);
  if (!(await deps.isPrivacyGateOpen())) return false;
  deps.send({
    type: VISUAL_FINGERPRINT_MESSAGE,
    version: 1,
    payload: {
      payloadVersion: 1,
      visitId: visitIdForHref(deps.locationHref),
      domHash,
      observedAt: deps.now().toISOString(),
    },
  });
  return true;
};

export const startVisualFingerprinting = (): void => {
  const root = document.documentElement;
  if (root === null) return;
  void emitVisualFingerprintOnce({
    root,
    locationHref: window.location.href,
    now: () => new Date(),
    isPrivacyGateOpen: readVisualFingerprintPrivacyGate,
    send: (message) => {
      chrome.runtime.sendMessage(message).catch(() => undefined);
    },
  }).catch(() => undefined);
};
