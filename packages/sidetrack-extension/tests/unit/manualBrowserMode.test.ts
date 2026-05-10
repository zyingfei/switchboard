import { describe, expect, it } from 'vitest';

import {
  classifyManualNetworkOutcome,
  pageFromManualDocumentResponse,
  redactSensitiveHeaders,
  resolveManualBrowserMode,
} from '../e2e/helpers/manualBrowserMode';
import type { Page } from '@playwright/test';

describe('manual browser mode guardrails', () => {
  it('rejects stealth mode in routed-fixture-e2e', () => {
    expect(() =>
      resolveManualBrowserMode({
        requestedMode: 'persistent-playwright-stealth-experiment',
        routedFixture: true,
        env: {
          SIDETRACK_E2E_STEALTH_EXPERIMENT: '1',
        },
      }),
    ).toThrow(/not allowed in routed-fixture-e2e/u);
  });

  it('rejects stealth mode without the explicit opt-in env var', () => {
    expect(() =>
      resolveManualBrowserMode({
        requestedMode: 'persistent-playwright-stealth-experiment',
        env: {},
      }),
    ).toThrow(/requires SIDETRACK_E2E_STEALTH_EXPERIMENT=1/u);
  });
});

describe('manual network outcome classification', () => {
  it('classifies Cloudflare challenge URLs', () => {
    const result = classifyManualNetworkOutcome({
      url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/cmg/1',
      status: 200,
    });
    expect(result.outcome).toBe('cloudflare_challenge');
  });

  it('classifies third-party HTTP 403 as http_403', () => {
    const result = classifyManualNetworkOutcome({
      url: 'https://chatgpt.com/backend-api/conversation',
      status: 403,
    });
    expect(result.outcome).toBe('http_403');
  });

  it('redacts sensitive cookies, tokens, and authorization headers', () => {
    const result = redactSensitiveHeaders({
      Cookie: 'sid=secret',
      Authorization: 'Bearer secret',
      'X-Session-Token': 'secret',
      Accept: 'text/html',
    });
    expect(result.Cookie).toBe('[REDACTED]');
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['X-Session-Token']).toBe('[REDACTED]');
    expect(result.Accept).toBe('text/html');
  });

  it('tolerates frame-less early navigation document responses', () => {
    expect(
      pageFromManualDocumentResponse({
        frame: () => {
          throw new Error('Frame for this navigation request is not available');
        },
      }),
    ).toBeUndefined();

    const page = {} as Page;
    expect(
      pageFromManualDocumentResponse({
        frame: () => ({ page: () => page }),
      }),
    ).toBe(page);
  });
});
