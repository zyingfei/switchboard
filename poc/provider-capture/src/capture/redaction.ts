import type { CaptureWarning } from './model';

const apiKeyPattern =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const internalUrlPattern =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[^/\s]+\.(?:local|internal|corp))\S*/i;

const addWarning = (
  warnings: CaptureWarning[],
  code: CaptureWarning['code'],
  message: string,
): void => {
  if (!warnings.some((warning) => warning.code === code)) {
    warnings.push({ code, message, severity: 'warning' });
  }
};

export const buildCaptureWarnings = (text: string, url: string): CaptureWarning[] => {
  const warnings: CaptureWarning[] = [];
  const combined = `${url}\n${text}`;

  if (apiKeyPattern.test(combined)) {
    addWarning(warnings, 'possible_api_key', 'Visible text may contain an API key or access token.');
  }
  if (emailPattern.test(combined)) {
    addWarning(warnings, 'email', 'Visible text may contain an email address.');
  }
  if (internalUrlPattern.test(combined)) {
    addWarning(warnings, 'internal_url', 'Visible text may contain an internal or private URL.');
  }
  if (text.length > 30_000) {
    warnings.push({
      code: 'long_capture',
      message: 'Visible capture is long; review before using it as downstream context.',
      severity: 'info',
    });
  }

  return warnings;
};
