const TRACKING_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'srsltid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gid',
]);

const shouldStripParam = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return normalized.startsWith('utm_') || TRACKING_PARAM_NAMES.has(normalized);
};

export const canonicalizeUrl = (rawUrl: string): string => {
  const input = rawUrl.trim();
  if (input.length === 0) return input;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.replace(/#.*$/u, '');
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }
  url.hash = '';

  const stripKeys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (shouldStripParam(key)) stripKeys.add(key);
  }
  for (const key of stripKeys) url.searchParams.delete(key);

  return url.toString();
};
