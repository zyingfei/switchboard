export interface DispatchPreflight {
  targetProvider: string;
  targetUrl: string;
  promptLength: number;
  autoSend: boolean;
  warnings: string[];
}

export interface DispatchPreflightInput {
  targetProvider: string;
  targetUrl: string;
  promptText: string;
  autoSend: boolean;
}

const API_KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_]*(?:api|secret|token)[A-Za-z0-9_]*\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,})\b/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PRIVATE_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|[A-Za-z0-9.-]+\.internal)(?::\d+)?(?:\/\S*)?/i;

export const buildDispatchPreflight = ({
  targetProvider,
  targetUrl,
  promptText,
  autoSend,
}: DispatchPreflightInput): DispatchPreflight => {
  const warnings: string[] = [];
  if (promptText.length > 8_000) {
    warnings.push('prompt too long');
  }
  if (API_KEY_PATTERN.test(promptText)) {
    warnings.push('contains possible API key pattern');
  }
  if (EMAIL_PATTERN.test(promptText)) {
    warnings.push('contains email');
  }
  if (PRIVATE_URL_PATTERN.test(promptText)) {
    warnings.push('contains internal/private URL');
  }

  return {
    targetProvider,
    targetUrl,
    promptLength: promptText.length,
    autoSend,
    warnings,
  };
};
