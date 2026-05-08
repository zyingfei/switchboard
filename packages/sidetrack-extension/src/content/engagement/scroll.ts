export const scrollRatioForDocument = (doc: Document): number => {
  const element = doc.scrollingElement ?? doc.documentElement;
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop === 0) return 0;
  const ratio = element.scrollTop / maxScrollTop;
  if (!Number.isFinite(ratio)) return 0;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
};

export const throttle = (fn: () => void, waitMs: number): (() => void) => {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    const now = Date.now();
    const remaining = waitMs - (now - lastRun);
    if (remaining <= 0) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      lastRun = now;
      fn();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      lastRun = Date.now();
      fn();
    }, remaining);
  };
};
