export const isDocumentVisible = (doc: Pick<Document, 'visibilityState'>): boolean =>
  doc.visibilityState === 'visible';

export const isWindowFocused = (doc: Pick<Document, 'hasFocus'>): boolean => doc.hasFocus();

export const engagementVisitIdForLocation = (location: Pick<Location, 'href'>): string => {
  try {
    const url = new URL(location.href);
    url.hash = '';
    return `visit:${url.toString()}`;
  } catch {
    return `visit:${location.href.replace(/#.*$/u, '')}`;
  }
};
