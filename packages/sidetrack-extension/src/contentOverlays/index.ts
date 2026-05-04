// Native-DOM overlay mounters for the content script. The sidepanel
// React components (DejaVuPopover, AnnotationOverlay) can't mount in
// the host page (different runtime, no React, no design tokens), so
// we recreate the same visual surface here as plain DOM + a one-time
// injected stylesheet. CSS is the same v2 design language, scoped
// behind the .sidetrack-overlay-root container so host-page styles
// can't bleed in or out.

const STYLE_ID = 'sidetrack-overlay-style';
const ROOT_ID = 'sidetrack-overlay-root';

const OVERLAY_CSS = `
.sidetrack-overlay-root {
  --paper: #f5efe2;
  --paper-light: #fbf7ee;
  --paper-deep: #e8dfc8;
  --ink: #1b1916;
  --ink-2: #4a453d;
  --ink-3: #7a7269;
  --ink-4: #a39a8c;
  --rule: #d4cdb8;
  --rule-soft: #e5ddc9;
  --signal: #c2410c;
  --signal-tint: #fed7aa;
  --signal-bg: #fff7ed;
  --amber: #a16207;
  --amber-tint: #fef3c7;
  --green: #166534;
  --display: 'Fraunces', 'EB Garamond', Georgia, serif;
  --body: 'Source Serif 4', Georgia, serif;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
  font-family: var(--body);
  color: var(--ink);
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483640;
  font-size: 13px;
  line-height: 1.5;
}
.sidetrack-overlay-root * { box-sizing: border-box; }
.sidetrack-ann-margin {
  position: absolute;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 99px;
  background: var(--paper-light);
  border: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  box-shadow: 0 4px 12px -4px rgba(0,0,0,0.15);
  pointer-events: auto;
  cursor: pointer;
}
.sidetrack-ann-margin:hover {
  background: var(--signal-bg);
  border-color: var(--signal-tint);
}
.sidetrack-ann-margin .dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--signal);
}
.sidetrack-ann-hint {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--paper-light);
  border: 1px solid var(--rule);
  border-radius: 99px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  pointer-events: auto;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,0.2);
}
.sidetrack-ann-hint .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--signal);
}
.sidetrack-ann-hint button {
  font-family: var(--mono);
  font-size: 10px;
  background: var(--ink);
  color: var(--paper-light);
  border: 1px solid var(--ink);
  padding: 3px 9px;
  border-radius: 99px;
  cursor: pointer;
}
.sidetrack-ann-hint .close {
  background: transparent;
  color: var(--ink-3);
  border: none;
  cursor: pointer;
  padding: 0 4px;
  font-size: 13px;
  line-height: 1;
}
.sidetrack-deja-pop {
  position: absolute;
  background: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 8px;
  width: 360px;
  max-width: 90vw;
  box-shadow: 0 22px 60px -12px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.05);
  pointer-events: auto;
  overflow: hidden;
}
.sidetrack-deja-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule-soft);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--signal);
}
.sidetrack-deja-head .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--signal);
}
.sidetrack-deja-head .meta {
  margin-left: auto;
  color: var(--ink-3);
}
.sidetrack-deja-head .close {
  background: transparent;
  color: var(--ink-3);
  border: none;
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
}
.sidetrack-deja-head .close:hover { color: var(--ink); }
.sidetrack-deja-list {
  max-height: 280px;
  overflow: auto;
}
.sidetrack-deja-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-bottom: 1px solid var(--rule-soft);
  font-family: inherit;
  color: inherit;
}
.sidetrack-deja-row:hover { background: var(--paper); }
.sidetrack-deja-row .r1 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}
.sidetrack-deja-row .title {
  flex: 1;
  font-family: var(--display);
  font-weight: 500;
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidetrack-deja-row .score {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--signal);
  background: var(--signal-bg);
  border: 1px solid var(--signal-tint);
  padding: 1px 5px;
  border-radius: 3px;
}
.sidetrack-deja-row .snippet {
  font-family: var(--display);
  font-style: italic;
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.45;
  padding-left: 8px;
  border-left: 2px solid var(--signal-tint);
  margin: 4px 0 0;
}
.sidetrack-deja-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--paper);
  border-top: 1px solid var(--rule-soft);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-3);
}
`;

const ensureOverlayInfra = (): HTMLElement => {
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = OVERLAY_CSS;
    document.head.appendChild(style);
  }
  let root = document.getElementById(ROOT_ID);
  if (root === null) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'sidetrack-overlay-root';
    document.body.appendChild(root);
  }
  return root;
};

const clearAnnotationMarkers = (root: HTMLElement): void => {
  for (const node of root.querySelectorAll('.sidetrack-ann-margin, .sidetrack-ann-hint')) {
    node.remove();
  }
};

export interface RestoredAnchor {
  readonly id: string;
  readonly rect: DOMRect;
}

// Mount per-anchor margin markers and a single bottom hint. Idempotent:
// re-calling clears any prior overlays first.
export const mountAnnotationOverlay = (anchors: readonly RestoredAnchor[]): void => {
  if (anchors.length === 0) return;
  const root = ensureOverlayInfra();
  clearAnnotationMarkers(root);
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.documentElement.clientHeight,
    1,
  );
  for (const anchor of anchors) {
    const marker = document.createElement('div');
    marker.className = 'sidetrack-ann-margin';
    const rectTop = anchor.rect.top + window.scrollY;
    const topPercent = Math.max(2, Math.min(96, (rectTop / docHeight) * 100));
    marker.style.top = `${String(topPercent)}%`;
    marker.title = `Annotation ${anchor.id}`;
    marker.innerHTML = '<span class="dot"></span><span>1</span>';
    root.appendChild(marker);
  }
  const hint = document.createElement('div');
  hint.className = 'sidetrack-ann-hint';
  hint.innerHTML = `
    <span class="dot"></span>
    <span>${String(anchors.length)} annotation${anchors.length === 1 ? '' : 's'} restored</span>
    <button type="button" class="close" aria-label="Dismiss">×</button>
  `;
  hint.querySelector('.close')?.addEventListener('click', () => {
    hint.remove();
  });
  root.appendChild(hint);
};

export interface DejaVuItem {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly relativeWhen: string;
}

interface DejaVuMountOptions {
  readonly items: readonly DejaVuItem[];
  readonly anchorRect: DOMRect;
  readonly onJump?: (item: DejaVuItem) => void;
  readonly onDismiss?: () => void;
}

const POP_WIDTH = 360;

const clearDejaPop = (root: HTMLElement): void => {
  for (const node of root.querySelectorAll('.sidetrack-deja-pop')) {
    node.remove();
  }
};

// Mount the Déjà-vu popover anchored just above the selection's bounding
// rect, clamped to the viewport with 8px padding.
export const mountDejaVuPopover = (opts: DejaVuMountOptions): { close: () => void } => {
  if (opts.items.length === 0) {
    return { close: () => undefined };
  }
  const root = ensureOverlayInfra();
  clearDejaPop(root);
  const pop = document.createElement('div');
  pop.className = 'sidetrack-deja-pop';
  const viewportWidth = document.documentElement.clientWidth;
  let left = opts.anchorRect.left + opts.anchorRect.width / 2 - POP_WIDTH / 2;
  if (left < 8) left = 8;
  if (left + POP_WIDTH > viewportWidth - 8) left = viewportWidth - 8 - POP_WIDTH;
  // Default: above the selection. Flip below if it would go off-screen.
  let top = opts.anchorRect.top - 8;
  let placeAbove = true;
  if (top < 80) {
    top = opts.anchorRect.bottom + 8;
    placeAbove = false;
  }
  pop.style.left = `${String(left)}px`;
  pop.style.top = `${String(placeAbove ? top - 320 : top)}px`;
  pop.innerHTML = `
    <div class="sidetrack-deja-head">
      <span class="dot"></span>
      <span>Seen this before</span>
      <span class="meta">${String(opts.items.length)} prior thread${opts.items.length === 1 ? '' : 's'}</span>
      <button type="button" class="close" aria-label="Dismiss">×</button>
    </div>
    <div class="sidetrack-deja-list"></div>
    <div class="sidetrack-deja-foot">
      <span style="flex:1">on-device · vector recall</span>
    </div>
  `;
  const list = pop.querySelector<HTMLDivElement>('.sidetrack-deja-list');
  if (list !== null) {
    for (const item of opts.items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sidetrack-deja-row';
      row.innerHTML = `
        <div class="r1">
          <span class="title"></span>
          <span class="score"></span>
        </div>
        <div class="snippet"></div>
      `;
      const titleEl = row.querySelector('.title');
      if (titleEl !== null) titleEl.textContent = item.title;
      const scoreEl = row.querySelector('.score');
      if (scoreEl !== null) scoreEl.textContent = item.score.toFixed(2);
      const snippetEl = row.querySelector('.snippet');
      if (snippetEl !== null) snippetEl.textContent = item.snippet;
      row.addEventListener('click', () => {
        opts.onJump?.(item);
      });
      list.appendChild(row);
    }
  }
  const close = () => {
    pop.remove();
    opts.onDismiss?.();
  };
  pop.querySelector('.close')?.addEventListener('click', close);
  root.appendChild(pop);
  return { close };
};
