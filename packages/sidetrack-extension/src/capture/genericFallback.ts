import type { CaptureEvent } from '../companion/model';
import { detectProviderFromUrl } from './providerDetection';

export interface GenericTabSnapshot {
  readonly url?: string;
  readonly title?: string;
  readonly favIconUrl?: string;
}

export const captureGenericTab = (
  tab: GenericTabSnapshot,
  capturedAt = new Date().toISOString(),
): CaptureEvent => {
  if (tab.url === undefined || tab.url.length === 0) {
    throw new Error('Cannot track a tab without a URL.');
  }

  return {
    provider: detectProviderFromUrl(tab.url),
    threadUrl: tab.url,
    title: tab.title ?? tab.url,
    capturedAt,
    selectorCanary: 'warning',
    turns: [],
  };
};
