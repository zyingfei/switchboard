import type { SerializedAnchor } from '../annotation/anchors';
import type { ProviderId } from '../companion/model';
import type { SearchHitFacet } from '../sidepanel/search/types';
import { formatRelative } from '../util/time';
import {
  dejaVuCategoriesPresent,
  dejaVuCategoryLabel,
  dejaVuCategoryOf,
  dejaVuFacetChipLabel,
  dejaVuFacetLabel,
} from './dejaVuModel';

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
.sidetrack-ann-highlight {
  position: fixed;
  border-radius: 4px;
  background: rgba(254, 215, 170, 0.55);
  box-shadow: inset 0 0 0 1px rgba(194, 65, 12, 0.38);
  mix-blend-mode: multiply;
  pointer-events: auto;
  cursor: pointer;
}
.sidetrack-ann-highlight:hover {
  background: rgba(254, 215, 170, 0.78);
  box-shadow: inset 0 0 0 1px rgba(194, 65, 12, 0.62);
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
  width: 440px;
  max-width: 92vw;
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
.sidetrack-deja-head .sidetrack-deja-mute {
  background: transparent;
  color: var(--ink-3);
  border: 1px solid var(--rule);
  border-radius: 99px;
  cursor: pointer;
  padding: 2px 7px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0;
  text-transform: none;
}
.sidetrack-deja-head .sidetrack-deja-mute:hover {
  color: var(--ink);
  border-color: var(--signal-tint);
  background: var(--signal-bg);
}
.sidetrack-deja-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 7px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule-soft);
}
.sidetrack-deja-chip {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-3);
  background: var(--paper-light);
  border: 1px solid var(--rule);
  border-radius: 99px;
  padding: 2px 9px;
  cursor: pointer;
}
.sidetrack-deja-chip:hover {
  color: var(--ink);
  border-color: var(--signal-tint);
}
.sidetrack-deja-chip.active {
  color: var(--signal);
  background: var(--signal-bg);
  border-color: var(--signal-tint);
}
.sidetrack-deja-facet {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--signal);
  background: var(--signal-bg);
  border: 1px solid var(--signal-tint);
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
}
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
  cursor: default;
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
  flex: 1 1 auto;
  /* min-width:0 is the load-bearing fix — without it the title
     refuses to shrink and gets ellipsised at ~12 chars while the
     metadata pills take their full intrinsic width. */
  min-width: 0;
  font-family: var(--display);
  font-weight: 600;
  font-size: 13.5px;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidetrack-deja-row .title.is-redacted {
  font-weight: 400;
  font-style: italic;
  color: var(--ink-3);
  font-size: 12px;
}
.cx-deja-marker {
  flex: none;
  font-family: var(--mono);
  font-size: 9px;
  line-height: 1.4;
  color: var(--ink-3);
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 99px;
  padding: 1px 6px;
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
.sidetrack-deja-provider {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--ink-2);
  background: var(--paper);
  border: 1px solid var(--rule);
  padding: 1px 5px;
  border-radius: 99px;
  white-space: nowrap;
}
.sidetrack-deja-when {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--ink-3);
  white-space: nowrap;
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
.sidetrack-deja-row .r2 {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 7px;
}
.sidetrack-deja-why-panel {
  margin-top: 6px;
  padding: 6px 9px;
  background: var(--paper);
  border: 1px solid var(--rule-soft);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  line-height: 1.5;
}
.sidetrack-deja-why-line {
  color: var(--ink-3);
}
.sidetrack-deja-why-line + .sidetrack-deja-why-line {
  margin-top: 2px;
  padding-top: 2px;
  border-top: 1px dashed var(--rule-soft);
}
.sidetrack-deja-row .r2 button {
  font-family: var(--mono);
  font-size: 10px;
  border-radius: 99px;
  border: 1px solid var(--rule);
  background: var(--paper-light);
  color: var(--ink-2);
  padding: 3px 8px;
  cursor: pointer;
}
.sidetrack-deja-row .r2 button:hover {
  border-color: var(--signal-tint);
  background: var(--signal-bg);
  color: var(--ink);
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
.sidetrack-deja-foot-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidetrack-deja-seeall-slot {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.sidetrack-deja-seeall {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--signal);
  background: var(--signal-bg);
  border: 1px solid var(--signal-tint);
  border-radius: 99px;
  padding: 3px 11px;
  cursor: pointer;
  /* nowrap + flex:none keeps the pill from collapsing into the
     3-line oval it shows when actions wrap and squeeze the footer. */
  white-space: nowrap;
  flex: none;
}
.sidetrack-deja-seeall:hover {
  color: var(--ink);
  border-color: var(--signal);
}
.sidetrack-deja-actions {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.sidetrack-rv-chip-group {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  pointer-events: auto;
}
.sidetrack-rv-chip {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: var(--ink);
  color: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 99px;
  font-family: var(--mono);
  font-size: 10.5px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,0.25);
}
.sidetrack-rv-chip:hover { background: var(--signal); border-color: var(--signal); }
/* Both chips share the same dark-on-paper palette so they read as a
   single chip cluster. The Déjà-vu chip used to invert (paper bg,
   ink text), which broke the visual pairing — they looked like two
   different controls instead of two siblings of one selection
   action. Glyphs differentiate intent. */
.sidetrack-rv-chip .glyph {
  font-family: var(--display); font-size: 12px; line-height: 1; font-weight: 500;
}
.sidetrack-rv-pop {
  position: absolute;
  background: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 8px;
  width: 320px;
  max-width: 90vw;
  pointer-events: auto;
  box-shadow: 0 22px 60px -12px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.05);
  overflow: hidden;
}
.sidetrack-rv-pop .head {
  padding: 8px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule-soft);
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--signal);
  display: flex; align-items: center; gap: 8px;
}
.sidetrack-rv-pop .head .meta { margin-left: auto; color: var(--ink-3); }
.sidetrack-rv-pop .head .close {
  background: transparent; color: var(--ink-3); border: none; cursor: pointer;
  padding: 0 4px; font-size: 14px; line-height: 1;
}
.sidetrack-rv-pop .head .close:hover { color: var(--ink); }
.sidetrack-rv-pop .quote {
  padding: 10px 12px 6px;
  font-family: var(--display); font-style: italic;
  font-size: 12px; color: var(--ink-2); line-height: 1.45;
  border-left: 2px solid var(--signal-tint);
  margin: 8px 12px 4px;
}
.sidetrack-rv-pop textarea {
  display: block; width: calc(100% - 24px); margin: 6px 12px 8px;
  min-height: 80px; resize: vertical;
  font-family: var(--body); font-size: 13px; color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--rule); border-radius: 5px;
  padding: 7px 9px; outline: none;
}
.sidetrack-rv-pop textarea:focus { border-color: var(--ink-3); }
.sidetrack-rv-pop .acts {
  display: flex; gap: 6px; padding: 7px 12px;
  background: var(--paper); border-top: 1px solid var(--rule-soft);
}
.sidetrack-rv-pop .acts .grow { flex: 1; }
.sidetrack-rv-pop .acts button {
  font-family: var(--mono); font-size: 10.5px;
  padding: 5px 11px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--paper-light); color: var(--ink-2);
}
.sidetrack-rv-pop .acts button.primary {
  background: var(--ink); color: var(--paper-light); border-color: var(--ink);
}
.sidetrack-rv-pop .acts button.primary:hover { background: var(--signal); border-color: var(--signal); }
.sidetrack-rv-pop .acts button:disabled { opacity: 0.5; cursor: not-allowed; }
.sidetrack-ann-pop {
  position: absolute;
  width: 320px;
  max-width: 90vw;
  background: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 8px;
  box-shadow: 0 22px 60px -12px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.05);
  pointer-events: auto;
  overflow: hidden;
}
.sidetrack-ann-pop .head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule-soft);
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--signal);
}
.sidetrack-ann-pop .head .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--signal);
}
.sidetrack-ann-pop .head .meta { margin-left: auto; color: var(--ink-3); }
.sidetrack-ann-pop .head .nav {
  display: inline-flex; gap: 2px; margin-right: 4px;
}
.sidetrack-ann-pop .head .nav button {
  background: transparent; color: var(--ink-2); border: none; cursor: pointer;
  padding: 0 6px; font-size: 14px; line-height: 1; font-family: var(--mono);
}
.sidetrack-ann-pop .head .nav button:hover:not(:disabled) { color: var(--ink); }
.sidetrack-ann-pop .head .nav button:disabled {
  color: var(--ink-3); opacity: 0.4; cursor: default;
}
.sidetrack-ann-pop .head .close {
  background: transparent; color: var(--ink-3); border: none; cursor: pointer;
  padding: 0 4px; font-size: 14px; line-height: 1;
}
.sidetrack-ann-pop .head .close:hover { color: var(--ink); }
.sidetrack-ann-pop .quote {
  margin: 8px 12px 0;
  padding: 4px 0 4px 8px;
  border-left: 2px solid var(--signal-tint);
  font-family: var(--display); font-style: italic;
  font-size: 12px; line-height: 1.45;
  color: var(--ink-2);
  max-height: 6em;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}
.sidetrack-ann-pop .note {
  padding: 8px 12px 12px;
  font-family: var(--body);
  font-size: 13px; line-height: 1.5;
  color: var(--ink);
  white-space: pre-wrap;
  word-wrap: break-word;
}
`;

const ensureOverlayInfra = (): HTMLElement => {
  // Always overwrite the style tag's textContent. Without this, an
  // older extension build that left a <style id=...> in the page
  // keeps its stale CSS (e.g. missing `position: absolute` on chips,
  // which collapses both buttons to the overlay root's top-left).
  // Replacing the textContent on every call costs ~nothing and keeps
  // the page in sync with the currently-loaded content script.
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (style === null) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== OVERLAY_CSS) {
    style.textContent = OVERLAY_CSS;
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
  for (const node of root.querySelectorAll(
    '.sidetrack-ann-highlight, .sidetrack-ann-margin, .sidetrack-ann-hint',
  )) {
    node.remove();
  }
};

export interface RestoredAnchor {
  readonly id: string;
  readonly rect: DOMRect;
  readonly rects?: readonly DOMRect[];
  // Note + quote enable click-to-reveal on the margin marker. Both
  // are optional so the legacy code paths that mount markers
  // without note context (e.g. transient session-only markers
  // before the persist call returns) still render.
  readonly note?: string;
  readonly quote?: string;
  // Original SerializedAnchor — when present, the resize / scroll
  // reposition path can re-resolve it against the live DOM if the
  // cached Range got detached by SPA virtualization (Gemini's
  // message virtualizer drops + re-creates DOM nodes on viewport
  // changes, leaving cached Ranges with empty client rects).
  readonly anchor?: SerializedAnchor;
}

// Cluster anchors that fall on the same line into one margin marker
// so a row with N annotations renders one dot with `${N}` instead of
// N stacked dots all stamped "1". Bucket size tracks line-height
// (24px is enough granularity to merge adjacent annotations on the
// same paragraph line, while still separating consecutive lines).
const ROW_BUCKET_PX = 24;

const clusterAnchorsByRow = (
  anchors: readonly RestoredAnchor[],
): readonly (readonly RestoredAnchor[])[] => {
  const buckets = new Map<number, RestoredAnchor[]>();
  for (const anchor of anchors) {
    const key = Math.floor((anchor.rect.top + window.scrollY) / ROW_BUCKET_PX);
    const list = buckets.get(key) ?? [];
    list.push(anchor);
    buckets.set(key, list);
  }
  // Sort within each cluster by horizontal position so ‹ / › walks
  // through them left-to-right matching the reading order.
  for (const list of buckets.values()) {
    list.sort((left, right) => left.rect.left - right.rect.left);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, list]) => list);
};

// Mount per-anchor highlights + per-row margin markers + a single
// bottom hint. Idempotent: re-calling clears any prior overlays
// first. Each marker is clickable — a paginated popover anchored
// near the dot cycles through every annotation that lives on that
// row; a second click on the dot or the popover's close dismisses.
export const mountAnnotationOverlay = (anchors: readonly RestoredAnchor[]): void => {
  if (anchors.length === 0) return;
  const root = ensureOverlayInfra();
  clearAnnotationMarkers(root);
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.documentElement.clientHeight,
    1,
  );

  const clusters = clusterAnchorsByRow(anchors);
  // Lookup: anchor.id → its cluster + index within that cluster.
  // Used by both the gutter marker (opens at index 0) and the inline
  // highlight click handler (opens at the clicked term's index).
  const clusterIndexById = new Map<
    string,
    { readonly cluster: readonly RestoredAnchor[]; readonly index: number }
  >();
  for (const cluster of clusters) {
    cluster.forEach((anchor, index) => {
      clusterIndexById.set(anchor.id, { cluster, index });
    });
  }

  const togglePopover = (
    cluster: readonly RestoredAnchor[],
    initialCursor: number,
    rect: DOMRect,
  ): void => {
    const head = cluster[0];
    if (head === undefined) return;
    const existing = root.querySelector<HTMLElement>(
      `.sidetrack-ann-pop[data-cluster-id="${CSS.escape(head.id)}"]`,
    );
    if (existing !== null) {
      existing.remove();
      return;
    }
    mountAnnotationNotePopover({
      anchors: cluster,
      anchorRect: rect,
      initialCursor,
    });
  };

  // Highlights still mount per-anchor so each individual term lights
  // up on the page; the marker collation only affects the gutter
  // dot/popover. Each highlight is now clickable and opens the same
  // popover as the gutter dot, with the cursor on the clicked term.
  for (const anchor of anchors) {
    const highlightRects = anchor.rects ?? [anchor.rect];
    for (const [index, rect] of highlightRects.entries()) {
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const highlight = document.createElement('div');
      highlight.className = 'sidetrack-ann-highlight';
      highlight.dataset.annId = anchor.id;
      highlight.dataset.annRect = String(index);
      if (anchor.quote !== undefined && anchor.quote.length > 0) {
        highlight.title = anchor.quote;
      }
      highlight.style.left = `${String(Math.round(rect.left))}px`;
      highlight.style.top = `${String(Math.round(rect.top))}px`;
      highlight.style.width = `${String(Math.round(rect.width))}px`;
      highlight.style.height = `${String(Math.round(rect.height))}px`;
      highlight.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const entry = clusterIndexById.get(anchor.id);
        if (entry === undefined) return;
        togglePopover(entry.cluster, entry.index, highlight.getBoundingClientRect());
      });
      root.appendChild(highlight);
    }
  }

  for (const cluster of clusters) {
    const head = cluster[0];
    if (head === undefined) continue;
    const marker = document.createElement('div');
    marker.className = 'sidetrack-ann-margin';
    marker.dataset.clusterId = head.id;
    const rectTop = head.rect.top + window.scrollY;
    const topPercent = Math.max(2, Math.min(96, (rectTop / docHeight) * 100));
    marker.style.top = `${String(topPercent)}%`;
    marker.title =
      cluster.length === 1
        ? head.note !== undefined && head.note.length > 0
          ? `Click to read · ${head.note.slice(0, 60)}${head.note.length > 60 ? '…' : ''}`
          : `Annotation ${head.id}`
        : `${String(cluster.length)} annotations on this line — click to browse`;
    marker.innerHTML = `<span class="dot"></span><span>${String(cluster.length)}</span>`;
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePopover(cluster, 0, marker.getBoundingClientRect());
    });
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

interface AnnotationNotePopoverOptions {
  readonly anchors: readonly RestoredAnchor[];
  readonly anchorRect: DOMRect;
  // Index within `anchors` to land on first. Defaults to 0; the
  // highlight click path passes the anchor's index inside its
  // cluster so the popover opens on the term the user actually
  // clicked, not the leftmost one.
  readonly initialCursor?: number;
}

const ANN_POP_WIDTH = 320;

const clearAnnotationPopovers = (root: HTMLElement): void => {
  for (const node of root.querySelectorAll('.sidetrack-ann-pop')) {
    node.remove();
  }
};

// Read-only popover for an annotation cluster (one row → one
// popover). When the cluster has >1 anchors, ‹ / › buttons cycle
// through the entries in left-to-right reading order. Position: to
// the left of the marker (markers sit in the right gutter), with
// vertical clamp so it stays inside the viewport. Click outside or
// the close button dismisses.
export const mountAnnotationNotePopover = (
  opts: AnnotationNotePopoverOptions,
): { close: () => void } => {
  const root = ensureOverlayInfra();
  clearAnnotationPopovers(root);
  if (opts.anchors.length === 0) {
    return { close: () => undefined };
  }
  const pop = document.createElement('div');
  pop.className = 'sidetrack-ann-pop';
  const head = opts.anchors[0];
  if (head !== undefined) {
    pop.dataset.clusterId = head.id;
  }
  const multi = opts.anchors.length > 1;
  pop.innerHTML = `
    <div class="head">
      <span class="dot"></span>
      <span>annotation</span>
      <span class="meta"></span>
      ${multi ? '<span class="nav"><button type="button" class="prev" aria-label="Previous">‹</button><button type="button" class="next" aria-label="Next">›</button></span>' : ''}
      <button type="button" class="close" aria-label="Dismiss">×</button>
    </div>
    <div class="quote"></div>
    <div class="note"></div>
  `;
  let cursor = Math.min(Math.max(opts.initialCursor ?? 0, 0), opts.anchors.length - 1);
  const quoteEl = pop.querySelector<HTMLElement>('.quote');
  const noteEl = pop.querySelector<HTMLElement>('.note');
  const metaEl = pop.querySelector<HTMLElement>('.meta');
  const prevBtn = pop.querySelector<HTMLButtonElement>('.prev');
  const nextBtn = pop.querySelector<HTMLButtonElement>('.next');

  const render = (): void => {
    const current = opts.anchors[cursor];
    if (current === undefined) return;
    if (metaEl !== null) {
      metaEl.textContent = multi ? `${String(cursor + 1)} / ${String(opts.anchors.length)}` : '';
    }
    if (quoteEl !== null) {
      if (current.quote !== undefined && current.quote.length > 0) {
        // setText keeps the host page's HTML out of the popover —
        // both fields come from untrusted captured turn / user
        // input.
        quoteEl.textContent = current.quote;
        quoteEl.style.display = '';
      } else {
        quoteEl.textContent = '';
        quoteEl.style.display = 'none';
      }
    }
    if (noteEl !== null) {
      noteEl.textContent =
        current.note !== undefined && current.note.length > 0 ? current.note : '(no note attached)';
    }
    if (prevBtn !== null) prevBtn.disabled = cursor === 0;
    if (nextBtn !== null) nextBtn.disabled = cursor === opts.anchors.length - 1;
  };
  render();

  prevBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (cursor > 0) {
      cursor -= 1;
      render();
    }
  });
  nextBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (cursor < opts.anchors.length - 1) {
      cursor += 1;
      render();
    }
  });
  pop.querySelector<HTMLButtonElement>('.close')?.addEventListener('click', () => {
    pop.remove();
  });
  // Left/right arrow keys also walk the cluster while the popover
  // is open. Listener lives on the popover so it doesn't fight
  // arrow-key navigation elsewhere on the page.
  pop.tabIndex = -1;
  pop.addEventListener('keydown', (event) => {
    if (!multi) return;
    if (event.key === 'ArrowLeft' && cursor > 0) {
      event.preventDefault();
      cursor -= 1;
      render();
    } else if (event.key === 'ArrowRight' && cursor < opts.anchors.length - 1) {
      event.preventDefault();
      cursor += 1;
      render();
    }
  });

  // Left of the marker: marker is in the right gutter, popover slides
  // out toward the page body. If there isn't room on the left (rare
  // — the gutter is at viewport right), pin to the right edge.
  const margin = 8;
  const viewportH = document.documentElement.clientHeight;
  let left = opts.anchorRect.left - ANN_POP_WIDTH - 10;
  if (left < margin) {
    left = Math.max(margin, opts.anchorRect.right - ANN_POP_WIDTH);
  }
  pop.style.left = `${String(Math.round(left))}px`;
  pop.style.top = `${String(Math.round(Math.min(opts.anchorRect.top, viewportH - 80)))}px`;
  root.appendChild(pop);
  if (multi) {
    pop.focus();
  }

  const onDocClick = (event: MouseEvent): void => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('.sidetrack-ann-pop') === null &&
      target.closest('.sidetrack-ann-margin') === null
    ) {
      pop.remove();
      document.removeEventListener('mousedown', onDocClick);
    }
  };
  // Defer one frame so the click that opened the popover doesn't
  // immediately close it.
  window.requestAnimationFrame(() => {
    document.addEventListener('mousedown', onDocClick);
  });

  return {
    close: () => {
      pop.remove();
      document.removeEventListener('mousedown', onDocClick);
    },
  };
};

type DejaVuMarker =
  | 'current_chat'
  // 'open_tab' is reserved for a follow-up service-worker addition
  // that tracks open chat URLs in real time; only 'recently_created'
  // is wired in this commit.
  | 'open_tab'
  | 'recently_created';

const dejaVuMarkerLabel = (marker: DejaVuMarker): string => {
  if (marker === 'current_chat') return 'Current';
  if (marker === 'open_tab') return 'Open';
  return 'Recent';
};

export interface DejaVuItem {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly relativeWhen: string;
  readonly marker?: DejaVuMarker;
  readonly provider?: ProviderId;
  readonly threadUrl?: string;
  // Full thread bac_id + last-seen timestamp from the recall result.
  // Plumbed through Jump so the side panel can synthesize a card
  // for threads that aren't yet in the local thread cache (e.g.
  // captured on another device, only in the companion's vault).
  readonly bacId?: string;
  // P3 unified search: which facet this hit is (page vs chat vs
  // thread) — drives the type-filter chips + the per-row tag.
  readonly facet?: SearchHitFacet;
  // Set for page-content hits (no threadUrl); Jump opens it.
  readonly canonicalUrl?: string;
  // 0–1 cosine, only on 'similar' (semantic) hits — shown instead of
  // a snippet (these are topical/vector matches, not exact text).
  readonly similarity?: number;
  // P3 — per-row evidence for the Why? expander. Each entry is one
  // source that contributed (bm25 / dense / fts5). Renders as a small
  // pill panel next to the action row.
  readonly evidence?: readonly {
    readonly retriever: string;
    readonly sourceKind: string;
    readonly rank?: number;
    readonly rawScore?: number;
    readonly vectorDistance?: number;
  }[];
}

type AskAiProvider = 'chatgpt' | 'claude' | 'gemini';

interface DejaVuMountOptions {
  readonly items: readonly DejaVuItem[];
  readonly anchorRect: DOMRect;
  readonly onJump?: (item: DejaVuItem) => void;
  readonly onMute?: () => void;
  readonly onDismiss?: () => void;
  // Always-shown footer actions on the highlighted selection: web
  // search + copy-and-open-a-new-AI-chat. Rendered only when wired.
  readonly onWebSearch?: () => void;
  readonly onTranslate?: () => void;
  readonly onAskAi?: (provider: AskAiProvider) => void;
  // Hand the current result set off to the sidepanel Connections →
  // Déjà-vu submode so the user can browse the full list with the
  // same chips/snippets at a roomier scale. Rendered only when wired.
  readonly onSeeAll?: () => void;
  /** Provider highlighted as the default (the current page's, else gpt). */
  readonly defaultAiProvider?: AskAiProvider;
}

const POP_WIDTH = 440;

const clearDejaPop = (root: HTMLElement): void => {
  for (const node of root.querySelectorAll('.sidetrack-deja-pop')) {
    node.remove();
  }
};

// Inline review chip — a compact "+ Comment" pill that floats next to
// the user's text selection inside an extracted turn. Clicking the
// chip swaps in a small popover with the quoted text + a textarea
// + Save / Cancel. Saving fires the onSave callback (the content
// script forwards it to the background as appendReviewDraftSpan).
//
// Position is computed from the selection's bounding rect — chip
// hovers a few px below the right edge; popover mounts in the same
// quadrant, clamped to the viewport.

interface ReviewChipMountOptions {
  readonly anchorRect: DOMRect;
  readonly quote: string;
  // Optional: when omitted the "+ Comment" button is not rendered
  // (Déjà-vu-only chip — used on non-provider pages where there is no
  // turn/thread to annotate).
  readonly onSave?: (comment: string) => Promise<void> | void;
  readonly onDismiss?: () => void;
  // When provided, the chip renders a second button "Déjà-vu" that
  // unconditionally invokes this callback. The caller (content
  // script) handles fetching recall + mounting the popover, even
  // when results are empty (so the user gets explicit "no matches"
  // feedback instead of the previous silent no-op).
  readonly onDejaVu?: () => void;
}

const POP_WIDTH_RV = 320;

const clearReviewOverlays = (root: HTMLElement): void => {
  for (const node of root.querySelectorAll(
    '.sidetrack-rv-chip, .sidetrack-rv-chip-group, .sidetrack-rv-pop',
  )) {
    node.remove();
  }
};

export const mountReviewSelectionChip = (opts: ReviewChipMountOptions): { close: () => void } => {
  const root = ensureOverlayInfra();
  clearReviewOverlays(root);

  // Anchor: chip pair sits just below the selection's bounding rect,
  // clamped to viewport. Two independent absolute-positioned chips —
  // simpler than a wrapper div with flex (the wrapper version was
  // dropping the + Comment button on some renders, see prior bug).
  // Widths are calibrated to the rendered chip (mono 10.5px label +
  // 12px display glyph + 4px×2 padding + 5px inner gap → ~80px). The
  // constants used to over-allocate by ~30px each, leaving a stranded
  // visual gap between the two chips even though GAP was small.
  const COMMENT_W = 84;
  const DEJA_W = 84;
  const GAP = 4;
  const hasComment = opts.onSave !== undefined;
  const hasDeja = opts.onDejaVu !== undefined;
  const totalWidth =
    (hasComment ? COMMENT_W : 0) +
    (hasComment && hasDeja ? GAP : 0) +
    (hasDeja ? DEJA_W : 0);
  const viewportWidth = document.documentElement.clientWidth;
  let leftAnchor = Math.max(8, opts.anchorRect.right - 50);
  if (leftAnchor + totalWidth > viewportWidth - 8) {
    leftAnchor = viewportWidth - totalWidth - 8;
  }
  if (leftAnchor < 8) leftAnchor = 8;
  const chipTop = opts.anchorRect.bottom + 6;

  let commentBtn: HTMLButtonElement | undefined;
  if (hasComment) {
    commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.className = 'sidetrack-rv-chip';
    commentBtn.style.left = `${String(leftAnchor)}px`;
    commentBtn.style.top = `${String(chipTop)}px`;
    commentBtn.innerHTML = '<span class="glyph">+</span><span>Comment</span>';
  }

  let dejaBtn: HTMLButtonElement | undefined;
  if (hasDeja) {
    dejaBtn = document.createElement('button');
    dejaBtn.type = 'button';
    dejaBtn.className = 'sidetrack-rv-chip';
    dejaBtn.style.left = `${String(hasComment ? leftAnchor + COMMENT_W + GAP : leftAnchor)}px`;
    dejaBtn.style.top = `${String(chipTop)}px`;
    dejaBtn.innerHTML = '<span class="glyph">⟲</span><span>Déjà-vu</span>';
  }

  const close = (): void => {
    commentBtn?.remove();
    dejaBtn?.remove();
    for (const pop of root.querySelectorAll('.sidetrack-rv-pop')) {
      pop.remove();
    }
    opts.onDismiss?.();
  };

  const expandToPopover = (): void => {
    const onSave = opts.onSave;
    if (onSave === undefined) return;
    commentBtn?.remove();
    dejaBtn?.remove();
    const pop = document.createElement('div');
    pop.className = 'sidetrack-rv-pop';
    const viewportWidth = document.documentElement.clientWidth;
    let left = opts.anchorRect.left + opts.anchorRect.width / 2 - POP_WIDTH_RV / 2;
    if (left < 8) left = 8;
    if (left + POP_WIDTH_RV > viewportWidth - 8) left = viewportWidth - 8 - POP_WIDTH_RV;
    pop.style.left = `${String(left)}px`;
    pop.style.top = `${String(opts.anchorRect.bottom + 6)}px`;

    const quoteCapped =
      opts.quote.length > 200 ? `${opts.quote.slice(0, 200).trimEnd()}…` : opts.quote;
    pop.innerHTML = `
      <div class="head">
        <span>Comment on selection</span>
        <span class="meta"></span>
        <button type="button" class="close" aria-label="Dismiss">×</button>
      </div>
      <div class="quote"></div>
      <textarea placeholder="What did this miss / get wrong / need next?" autofocus></textarea>
      <div class="acts">
        <span class="grow"></span>
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="primary save" disabled>Save</button>
      </div>
    `;
    const quoteEl = pop.querySelector('.quote');
    if (quoteEl !== null) quoteEl.textContent = quoteCapped;
    const textarea = pop.querySelector<HTMLTextAreaElement>('textarea');
    const saveBtn = pop.querySelector<HTMLButtonElement>('.save');
    if (textarea !== null && saveBtn !== null) {
      textarea.addEventListener('input', () => {
        saveBtn.disabled = textarea.value.trim().length === 0;
      });
      saveBtn.addEventListener('click', () => {
        const value = textarea.value.trim();
        if (value.length === 0) return;
        saveBtn.disabled = true;
        Promise.resolve(onSave(value))
          .then(() => {
            close();
          })
          .catch(() => {
            saveBtn.disabled = false;
          });
      });
    }
    pop.querySelector<HTMLButtonElement>('.cancel')?.addEventListener('click', close);
    pop.querySelector<HTMLButtonElement>('.head .close')?.addEventListener('click', close);
    root.appendChild(pop);
    window.setTimeout(() => textarea?.focus(), 0);
  };

  if (commentBtn !== undefined) {
    const commentBtnHandle = commentBtn;
    commentBtnHandle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      expandToPopover();
    });
  }
  if (dejaBtn !== undefined) {
    const dejaBtnHandle = dejaBtn;
    dejaBtnHandle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      commentBtn?.remove();
      dejaBtnHandle.remove();
      opts.onDejaVu?.();
    });
  }
  if (commentBtn !== undefined) {
    root.appendChild(commentBtn);
  }
  if (dejaBtn !== undefined) {
    root.appendChild(dejaBtn);
  }
  return { close };
};

const providerLabel = (provider: ProviderId | undefined): string => {
  if (provider === 'chatgpt') return 'ChatGPT';
  if (provider === 'claude') return 'Claude';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'codex') return 'Codex';
  return 'Generic';
};

// Mount the Déjà-vu popover anchored just above the selection's bounding
// rect, clamped to the viewport with 8px padding. Empty items now
// renders an explicit "no matches found" panel so the user sees
// the query ran (vs the previous silent no-mount which made the
// feature feel broken).
export const mountDejaVuPopover = (opts: DejaVuMountOptions): { close: () => void } => {
  const root = ensureOverlayInfra();
  clearDejaPop(root);
  const pop = document.createElement('div');
  pop.className = 'sidetrack-deja-pop';
  // Initial position is best-effort — the real clamp happens after
  // the popover mounts and we can measure its actual height. Until
  // then we use a left-aligned offscreen position so the user
  // never sees the unclamped intermediate frame.
  pop.style.left = '-9999px';
  pop.style.top = '0px';
  // Cap the height so a popover with many rows can't push past the
  // viewport. The list scrolls inside this max.
  pop.style.maxHeight = `${String(Math.min(420, document.documentElement.clientHeight - 40))}px`;
  pop.style.overflow = 'auto';
  const isEmpty = opts.items.length === 0;
  const presentFacets = (['page', 'chat', 'similar', 'thread'] as SearchHitFacet[]).filter(
    (f) => opts.items.some((i) => i.facet === f),
  );
  const presentCategories = dejaVuCategoriesPresent(opts.items);
  const itemCategory = (i: DejaVuItem): string =>
    dejaVuCategoryOf(i.canonicalUrl ?? i.threadUrl);
  // Show the Page/Chat + AI Chats/Google Services grouping whenever
  // there is more than one result — even if a dimension is
  // homogeneous (all-chat / all-web). The user wants the breakdown
  // visible CONSISTENTLY everywhere (regular pages and chat pages
  // alike), not silently dropped on single-type result sets the way
  // the old "only when it splits" gate did.
  const multi = opts.items.length > 1;
  const facetChips = multi ? presentFacets : [];
  // a1: drop the generic "Web" chip — it's "everything not AI-chat /
  // not Google", i.e. noise that duplicated the Page facet count and
  // confused (the "Page 4 / Web 4 — what's the difference?"). Keep
  // only the meaningful service categories; Web items still appear
  // under "All" and their Pages/Chats/Similar facet chip. Only the
  // "Google" category chip is kept: "AI Chats" overlapped the Chats
  // facet almost entirely (confusing duplicate); "Web" was noise.
  // Google-service pages are the one case the category adds info.
  const categoryChips = multi ? presentCategories.filter((c) => c === 'google') : [];
  const hasFilter = facetChips.length + categoryChips.length > 0;
  pop.innerHTML = `
    <div class="sidetrack-deja-head">
      <span class="dot"></span>
      <span>${isEmpty ? 'Déjà-vu' : 'Seen this before'}</span>
      <span class="meta">${
        isEmpty
          ? 'no prior matches'
          : `${String(opts.items.length)} prior result${opts.items.length === 1 ? '' : 's'}`
      }</span>
      <button type="button" class="sidetrack-deja-mute">Mute on this page</button>
      <button type="button" class="close" aria-label="Dismiss">×</button>
    </div>
    <div class="sidetrack-deja-chips"></div>
    <div class="sidetrack-deja-list"></div>
    <div class="sidetrack-deja-foot">
      <span class="sidetrack-deja-foot-label">on-device · unified recall</span>
      <span class="sidetrack-deja-seeall-slot"></span>
      <span class="sidetrack-deja-actions"></span>
    </div>
  `;
  const list = pop.querySelector<HTMLDivElement>('.sidetrack-deja-list');
  const chipsBar = pop.querySelector<HTMLDivElement>('.sidetrack-deja-chips');

  // "See all" handoff to the sidepanel Connections → Déjà-vu submode.
  // Rendered as a primary footer pill before the search/translate/ask
  // actions so it's the first thing the eye lands on when the result
  // set is bigger than what fits in the popover.
  const seeAllSlot = pop.querySelector<HTMLSpanElement>('.sidetrack-deja-seeall-slot');
  if (seeAllSlot !== null && opts.onSeeAll !== undefined && opts.items.length > 0) {
    const onSeeAll = opts.onSeeAll;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sidetrack-deja-seeall';
    b.textContent = `⇄ See all (${String(opts.items.length)})`;
    b.title = 'Open the full result set in the side panel';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSeeAll();
    });
    seeAllSlot.appendChild(b);
  }

  // Always-shown footer actions on the highlighted selection.
  const actionsBar = pop.querySelector<HTMLSpanElement>('.sidetrack-deja-actions');
  if (actionsBar !== null) {
    const mkAction = (label: string, title: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sidetrack-deja-chip';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      actionsBar.appendChild(b);
    };
    if (opts.onWebSearch !== undefined) {
      mkAction('🔍 Google', 'Google-search the highlighted text', opts.onWebSearch);
    }
    if (opts.onTranslate !== undefined) {
      mkAction('🌐 Translate', 'Translate the highlighted text (Google Translate)', opts.onTranslate);
    }
    if (opts.onAskAi !== undefined) {
      const onAskAi = opts.onAskAi;
      const dflt: AskAiProvider = opts.defaultAiProvider ?? 'chatgpt';
      const PROVIDERS: readonly { id: AskAiProvider; label: string }[] = [
        { id: 'chatgpt', label: 'GPT' },
        { id: 'claude', label: 'Claude' },
        { id: 'gemini', label: 'Gemini' },
      ];
      // Default provider first, then the others — one click each:
      // copies the selection + opens that provider's new chat.
      for (const p of [...PROVIDERS].sort((a) => (a.id === dflt ? -1 : 0))) {
        mkAction(
          p.id === dflt ? `🤖 Ask ${p.label}` : p.label,
          `Copy the selection and open a new ${p.label} chat`,
          () => onAskAi(p.id),
        );
      }
    }
  }

  const renderRow = (item: DejaVuItem): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'sidetrack-deja-row';
    row.innerHTML = `
      <div class="r1">
        <span class="title"></span>
        <span class="cx-deja-marker"></span>
        <span class="sidetrack-deja-facet"></span>
        <span class="sidetrack-deja-provider"></span>
        <span class="sidetrack-deja-when"></span>
        <span class="score"></span>
      </div>
      <div class="snippet"></div>
      <div class="r2">
        <button type="button" class="jump">↗ Open</button>
        <button type="button" class="mute">Mute on this page</button>
        <button type="button" class="why" aria-expanded="false">Why?</button>
      </div>
      <div class="sidetrack-deja-why-panel" hidden></div>
    `;
    const titleEl = row.querySelector('.title');
    if (titleEl !== null) {
      // Captures with no real title (URL fallback, blank string,
      // generic placeholder) read as visual noise next to the
      // metadata pills. Mark them so the CSS can de-emphasize them
      // and let real titles stand out — that's the "better display
      // for non-redacted results" the user asked for.
      const rawTitle = item.title.trim();
      const looksRedacted =
        rawTitle.length === 0 ||
        /^https?:\/\//i.test(rawTitle) ||
        rawTitle === '(no title)' ||
        rawTitle === 'Untitled';
      titleEl.textContent = rawTitle.length === 0 ? '(no title)' : rawTitle;
      if (looksRedacted) titleEl.classList.add('is-redacted');
    }
    const markerEl = row.querySelector('.cx-deja-marker');
    if (markerEl !== null) {
      if (item.marker === undefined) markerEl.remove();
      else markerEl.textContent = dejaVuMarkerLabel(item.marker);
    }
    const facetEl = row.querySelector('.sidetrack-deja-facet');
    if (facetEl !== null) {
      if (item.facet === undefined) facetEl.remove();
      else facetEl.textContent = dejaVuFacetLabel(item.facet);
    }
    const providerEl = row.querySelector('.sidetrack-deja-provider');
    if (providerEl !== null) providerEl.textContent = providerLabel(item.provider);
    const whenEl = row.querySelector('.sidetrack-deja-when');
    if (whenEl !== null) whenEl.textContent = formatRelative(item.relativeWhen);
    const scoreEl = row.querySelector('.score');
    if (scoreEl !== null) {
      // Only the 'similar' facet has a user-meaningful score (NN%
      // similar from the vector index). The lexical BM25 number for
      // pages/chats hits is internal ranking signal — surfacing it as
      // "186.67" reads as noise and steals horizontal room from the
      // title. Drop the badge entirely for non-similar rows.
      if (item.facet === 'similar' && item.similarity !== undefined) {
        scoreEl.textContent = `${String(Math.round(item.similarity * 100))}% similar`;
      } else {
        scoreEl.remove();
      }
    }
    const snippetEl = row.querySelector('.snippet');
    if (snippetEl !== null) {
      // Semantic hits intentionally have no exact-text snippet — drop
      // the empty line so the row is just title + similarity.
      if (item.facet === 'similar' || item.snippet.length === 0) snippetEl.remove();
      else snippetEl.textContent = item.snippet;
    }
    row.querySelector('.jump')?.addEventListener('click', () => {
      opts.onJump?.(item);
    });
    row.querySelector('.mute')?.addEventListener('click', () => {
      opts.onMute?.();
    });
    // P3 — Why? expander. Builds a small evidence panel from the
    // candidate's evidence[] (per-retriever rank + score + vector
    // distance). Click toggles visibility; folded by default so the
    // popover stays scannable.
    const whyBtn = row.querySelector<HTMLButtonElement>('.why');
    const whyPanel = row.querySelector<HTMLDivElement>('.sidetrack-deja-why-panel');
    if (whyBtn !== null && whyPanel !== null) {
      const ev = item.evidence;
      if (ev === undefined || ev.length === 0) {
        whyBtn.remove();
      } else {
        const fmtScore = (n: number | undefined): string =>
          n === undefined ? '—' : n.toFixed(3);
        const lines = ev.map((e) => {
          const src = e.sourceKind.replace('_', '-');
          const rank = e.rank !== undefined ? `rank ${String(e.rank)}` : '';
          const score = e.rawScore !== undefined ? `bm25 ${fmtScore(e.rawScore)}` : '';
          const vec =
            e.vectorDistance !== undefined
              ? `cosine ${fmtScore(1 - e.vectorDistance)}`
              : '';
          const bits = [e.retriever, src, rank, score, vec].filter((s) => s.length > 0);
          return bits.join(' · ');
        });
        whyPanel.innerHTML = lines
          .map((l) => `<div class="sidetrack-deja-why-line">${l}</div>`)
          .join('');
        whyBtn.addEventListener('click', () => {
          const open = whyBtn.getAttribute('aria-expanded') === 'true';
          if (open) {
            whyBtn.setAttribute('aria-expanded', 'false');
            whyPanel.setAttribute('hidden', '');
          } else {
            whyBtn.setAttribute('aria-expanded', 'true');
            whyPanel.removeAttribute('hidden');
          }
        });
      }
    }
    return row;
  };

  // Single-select filter key: 'all' | `f:<facet>` | `c:<category>`.
  // Facet and category are two orthogonal chip groups (Page/Chat vs
  // AI Chats/Google Services) but one active selection keeps the UX
  // simple and consistent with the rest of the panel.
  let activeKey = 'all';
  const matches = (i: DejaVuItem): boolean => {
    if (activeKey === 'all') return true;
    if (activeKey.startsWith('f:')) return i.facet === activeKey.slice(2);
    if (activeKey.startsWith('c:')) return itemCategory(i) === activeKey.slice(2);
    return true;
  };
  const renderList = (): void => {
    if (list === null) return;
    list.textContent = '';
    const shown = opts.items.filter(matches);
    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidetrack-deja-empty';
      empty.style.cssText =
        'padding: 18px 14px; text-align: center; color: var(--ink-3); font-style: italic; font-size: 12px;';
      empty.textContent = isEmpty
        ? 'No similar prior pages or conversations found in your vault.'
        : 'No results of this type.';
      list.appendChild(empty);
      return;
    }
    for (const item of shown) list.appendChild(renderRow(item));
  };

  if (chipsBar !== null && hasFilter) {
    const chipEls = new Map<string, HTMLButtonElement>();
    const syncChips = (): void => {
      for (const [k, el] of chipEls) el.classList.toggle('active', k === activeKey);
    };
    const addChip = (key: string, label: string, count: number): void => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sidetrack-deja-chip';
      chip.textContent = `${label} ${String(count)}`;
      chip.addEventListener('click', () => {
        activeKey = key;
        syncChips();
        renderList();
      });
      chipEls.set(key, chip);
      chipsBar.appendChild(chip);
    };
    addChip('all', 'All', opts.items.length);
    for (const f of facetChips) {
      addChip(`f:${f}`, dejaVuFacetChipLabel(f), opts.items.filter((i) => i.facet === f).length);
    }
    for (const c of categoryChips) {
      addChip(
        `c:${c}`,
        dejaVuCategoryLabel(c),
        opts.items.filter((i) => itemCategory(i) === c).length,
      );
    }
    syncChips();
  } else if (chipsBar !== null) {
    chipsBar.remove();
  }

  renderList();
  const close = () => {
    pop.remove();
    opts.onDismiss?.();
  };
  pop.querySelector('.close')?.addEventListener('click', close);
  pop.querySelector('.sidetrack-deja-mute')?.addEventListener('click', () => {
    opts.onMute?.();
  });
  root.appendChild(pop);
  // Now that the popover is in the DOM we know its real size and can
  // place it correctly relative to the selection. Order of preference:
  //   1. Above the selection if there's room for the full popover
  //   2. Below the selection if there's room there
  //   3. Pinned to the available edge (clamped) if neither side fits,
  //      so the popover stays on-screen even if it has to overlap the
  //      selection a little.
  // Width clamp is independent — center on selection, then pull back
  // from any viewport edge it would cross.
  const positionPopover = (): void => {
    const popRect = pop.getBoundingClientRect();
    const popHeight = popRect.height;
    const popWidth = popRect.width || POP_WIDTH;
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const margin = 8;
    const gap = 6;

    let left = opts.anchorRect.left + opts.anchorRect.width / 2 - popWidth / 2;
    if (left < margin) left = margin;
    if (left + popWidth > viewportW - margin) left = viewportW - margin - popWidth;

    const spaceAbove = opts.anchorRect.top - margin;
    const spaceBelow = viewportH - opts.anchorRect.bottom - margin;
    let top: number;
    if (popHeight + gap <= spaceAbove) {
      top = opts.anchorRect.top - popHeight - gap;
    } else if (popHeight + gap <= spaceBelow) {
      top = opts.anchorRect.bottom + gap;
    } else {
      // Neither side has the full popover height. Pin to whichever
      // side has more room and let the popover scroll internally
      // (the maxHeight cap above keeps it inside the viewport).
      if (spaceBelow >= spaceAbove) {
        top = Math.max(margin, viewportH - popHeight - margin);
      } else {
        top = margin;
      }
    }

    pop.style.left = `${String(Math.round(left))}px`;
    pop.style.top = `${String(Math.round(top))}px`;
  };
  // First pass synchronously after mount; second pass next frame in
  // case the row contents triggered a reflow that changed height.
  positionPopover();
  requestAnimationFrame(positionPopover);
  return { close };
};
