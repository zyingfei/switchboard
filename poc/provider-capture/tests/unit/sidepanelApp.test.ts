import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../entrypoints/sidepanel/App';
import { providerCaptureUiBuildId } from '../../src/shared/buildInfo';
import { providerMessages } from '../../src/shared/messages';

describe('sidepanel app', () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (request: { type: string }) => {
          if (request.type === providerMessages.getState) {
            return {
              ok: true,
              state: {
                captures: [
                  {
                    id: 'gemini-import',
                    provider: 'gemini',
                    url: 'chrome://glic/imported',
                    title: 'Gemini in Chrome - Imported conversation',
                    capturedAt: '2026-04-25T23:45:24.215Z',
                    extractionConfigVersion: '2026-04-25-gemini-chrome-import-v1',
                    selectorCanary: 'passed',
                    turns: [
                      {
                        id: 'turn-1',
                        role: 'assistant',
                        text: 'gemini chrome import response',
                        ordinal: 0,
                        sourceSelector: 'gemini chrome import response',
                      },
                    ],
                    visibleTextCharCount: 161,
                  },
                ],
                lastActiveTab: null,
                lastError: null,
                updatedAt: '2026-04-25T23:45:24.215Z',
              },
            };
          }

          return {
            ok: true,
            state: {
              captures: [],
              lastActiveTab: null,
              lastError: null,
              updatedAt: '2026-04-25T23:45:24.215Z',
            },
          };
        }),
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 1 })),
      },
      sidePanel: {
        open: vi.fn(async () => undefined),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.unstubAllGlobals();
  });

  it('renders imported Gemini captures that omit warnings and artifacts fields', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Gemini in Chrome - Imported conversation');
    expect(container.textContent).toContain('gemini chrome import response');
    expect(container.textContent).toContain(`Build ${providerCaptureUiBuildId}`);
  });
});
