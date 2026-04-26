const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const URL_RE = /\bhttps?:\/\/[^\s)]+/giu;
const TOKEN_RE = /\b[a-z0-9_\-]{20,}\b/giu;

export const maskSensitiveText = (text: string): string =>
  text
    .replace(EMAIL_RE, '[email]')
    .replace(URL_RE, '[url]')
    .replace(TOKEN_RE, '[secret]');

export const maskStructuredData = <TValue>(value: TValue): TValue => {
  if (typeof value === 'string') {
    return maskSensitiveText(value) as TValue;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskStructuredData(item)) as TValue;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskStructuredData(item)]),
    ) as TValue;
  }
  return value;
};
