import { describe, expect, it } from 'vitest';

import type { ConnectionNode } from '../../src/sidepanel/connections/types';
import {
  formatAnchorDisplay,
  formatEntityDisplay,
  formatNodeIdDisplay,
  hostOf,
  isInternalIdLike,
  type EntityDisplayCtx,
} from '../../src/sidepanel/entityDisplay/format';

const makeCtx = (overrides: Partial<EntityDisplayCtx> = {}): EntityDisplayCtx => ({
  resolveWorkstreamPath: () => null,
  replicaAlias: (id) => (id === 'this-replica' ? 'This browser' : 'Browser 2'),
  ...overrides,
});

const makeNode = (
  overrides: Partial<ConnectionNode> & Pick<ConnectionNode, 'id' | 'kind'>,
): ConnectionNode => ({
  label: '',
  originReplicaIds: [],
  metadata: {},
  ...overrides,
});

describe('entityDisplay/format', () => {
  describe('isInternalIdLike', () => {
    it('flags raw ULIDs', () => {
      expect(isInternalIdLike('ZYJFNMTBZXBYP5DE')).toBe(true);
      expect(isInternalIdLike('tses_01KR9Z623C1YYND57DVAGDPZPDV')).toBe(true);
      expect(isInternalIdLike('bac_01KR9Z623C')).toBe(true);
    });
    it('flags namespaced node ids', () => {
      expect(isInternalIdLike('visit-instance:tses_01KR:2026-05-10:https://x')).toBe(true);
      expect(isInternalIdLike('workstream:ZYJFNMTB')).toBe(true);
      expect(isInternalIdLike('thread:bac_abc')).toBe(true);
    });
    it('lets normal text through', () => {
      expect(isInternalIdLike('Switchboard PR review')).toBe(false);
      expect(isInternalIdLike('sideproject / sidetrack')).toBe(false);
      expect(isInternalIdLike('ChatGPT')).toBe(false);
    });
    it('handles empty / undefined / null', () => {
      expect(isInternalIdLike('')).toBe(false);
      expect(isInternalIdLike(undefined)).toBe(false);
      expect(isInternalIdLike(null)).toBe(false);
    });
  });

  describe('hostOf', () => {
    it('returns the host part of a URL', () => {
      expect(hostOf('https://chatgpt.com/g/g-p-x/c/y')).toBe('chatgpt.com');
      expect(hostOf('https://example.org:8080/path')).toBe('example.org:8080');
    });
    it('returns undefined for unparseable input', () => {
      expect(hostOf('not-a-url')).toBeUndefined();
      expect(hostOf('')).toBeUndefined();
      expect(hostOf(undefined)).toBeUndefined();
    });
  });

  describe('formatEntityDisplay — workstream', () => {
    it('uses ctx.resolveWorkstreamPath when available', () => {
      const node = makeNode({
        id: 'workstream:ZYJFNMTB',
        kind: 'workstream',
        label: 'ZYJFNMTB',
        metadata: { title: 'sidetrack' },
      });
      const display = formatEntityDisplay(
        node,
        makeCtx({ resolveWorkstreamPath: () => 'sideproject / sidetrack' }),
      );
      expect(display.primary).toBe('sideproject / sidetrack');
      expect(display.tooltip).toBe('ZYJFNMTB');
    });
    it('falls back to metadata.title when path is null', () => {
      const node = makeNode({
        id: 'workstream:ZYJFNMTB',
        kind: 'workstream',
        label: 'ZYJFNMTB',
        metadata: { title: 'sidetrack' },
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('sidetrack');
    });
    it('returns Unknown workstream when no path/title/clean label', () => {
      const node = makeNode({
        id: 'workstream:ZYJFNMTBZXBYP5DE',
        kind: 'workstream',
        label: 'ZYJFNMTBZXBYP5DE', // id-like (16-char Crockford ULID short code)
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('Unknown workstream');
      expect(display.primary).not.toContain('ZYJFNMTBZXBYP5DE');
    });
  });

  describe('formatEntityDisplay — tab-session', () => {
    it('prefers latestTitle when present', () => {
      const node = makeNode({
        id: 'tab-session:tses_01KR9Z',
        kind: 'tab-session',
        label: 'tses_01KR9Z',
        metadata: {
          latestTitle: 'ChatGPT — sidetrack',
          latestUrl: 'https://chatgpt.com/g/x',
        },
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('ChatGPT — sidetrack');
      expect(display.tooltip).toBe('https://chatgpt.com/g/x');
    });
    it('falls back to host when title is missing', () => {
      const node = makeNode({
        id: 'tab-session:tses_01KR9Z',
        kind: 'tab-session',
        label: 'tses_01KR9Z',
        metadata: { latestUrl: 'https://chatgpt.com/g/g-p-x/c/y' },
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('chatgpt.com');
    });
    it('returns untracked-tab placeholder when no metadata', () => {
      const node = makeNode({
        id: 'tab-session:tses_01KR9Z',
        kind: 'tab-session',
        label: 'tses_01KR9Z',
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('(untracked tab)');
      expect(display.primary).not.toContain('tses_');
    });
  });

  describe('formatEntityDisplay — visit-instance / timeline-visit', () => {
    it('uses metadata.title when present', () => {
      const node = makeNode({
        id: 'visit-instance:tses:date:https://example.com',
        kind: 'visit-instance',
        label: '',
        metadata: {
          title: 'Example article',
          canonicalUrl: 'https://example.com/article',
        },
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('Example article');
      expect(display.tooltip).toBe('https://example.com/article');
      // Critical: tooltip is canonical URL, not the visit-instance id.
      expect(display.tooltip).not.toContain('visit-instance:');
    });
    it('falls back to host when title is missing', () => {
      const node = makeNode({
        id: 'visit-instance:tses:date:url',
        kind: 'visit-instance',
        label: '',
        metadata: { canonicalUrl: 'https://example.com/article' },
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('example.com');
    });
  });

  describe('formatEntityDisplay — replica', () => {
    it('uses the alias resolver', () => {
      const node = makeNode({
        id: 'replica:this-replica',
        kind: 'replica',
        label: 'this-replica',
      });
      const display = formatEntityDisplay(node, makeCtx());
      expect(display.primary).toBe('This browser');
      expect(display.primary).not.toContain('this-replica');
    });
  });

  describe('formatNodeIdDisplay — missing node fallbacks', () => {
    const empty: ReadonlyMap<string, ConnectionNode> = new Map();
    it('workstream falls back to ctx path or Unknown workstream', () => {
      expect(formatNodeIdDisplay('workstream:ABC', empty, makeCtx()).primary).toBe(
        'Unknown workstream',
      );
      expect(
        formatNodeIdDisplay(
          'workstream:ABC',
          empty,
          makeCtx({ resolveWorkstreamPath: () => 'a / b' }),
        ).primary,
      ).toBe('a / b');
    });
    it('tab-session falls back to "Tab session" — never the raw id', () => {
      const display = formatNodeIdDisplay('tab-session:tses_01KR9Z', empty, makeCtx());
      expect(display.primary).toBe('Tab session');
      expect(display.primary).not.toContain('tses_');
    });
    it('visit-instance with trailing URL recovers the host', () => {
      const display = formatNodeIdDisplay(
        'visit-instance:tses_01KR9Z:2026-05-10T22:12:35.297Z:https://chatgpt.com/g/x/c/y',
        empty,
        makeCtx(),
      );
      expect(display.primary).toBe('chatgpt.com');
      expect(display.primary).not.toContain('tses_');
      expect(display.primary).not.toContain('visit-instance');
    });
    it('timeline-visit URL host', () => {
      const display = formatNodeIdDisplay('timeline-visit:https://example.com/x', empty, makeCtx());
      expect(display.primary).toBe('example.com');
    });
    it('completely unknown node still returns safe placeholder', () => {
      const display = formatNodeIdDisplay('weird:thing', empty, makeCtx());
      expect(display.primary).toBe('Unknown node');
    });
  });

  describe('formatAnchorDisplay — backward compat', () => {
    const empty: ReadonlyMap<string, ConnectionNode> = new Map();

    it('handles bare string anchors (legacy wire format)', () => {
      const display = formatAnchorDisplay(
        'visit-instance:tses_01KR9Z:2026-05-10:https://example.com/article',
        empty,
        makeCtx(),
      );
      expect(display.primary).toBe('example.com');
      expect(display.primary).not.toContain('tses_');
      expect(display.primary).not.toContain('visit-instance:');
    });

    it('handles enriched anchor objects (Phase C wire format)', () => {
      const node = makeNode({
        id: 'tab-session:tses_01KR9Z',
        kind: 'tab-session',
        label: 'Live snapshot title',
        metadata: { latestTitle: 'Live snapshot title' },
      });
      const display = formatAnchorDisplay(
        { id: 'tab-session:tses_01KR9Z', kind: 'tab-session', label: 'Resolver-side label' },
        new Map([['tab-session:tses_01KR9Z', node]]),
        makeCtx(),
      );
      // Live snapshot wins over resolver-supplied label.
      expect(display.primary).toBe('Live snapshot title');
    });

    it('falls back to resolver-supplied label when snapshot is empty', () => {
      const display = formatAnchorDisplay(
        { id: 'tab-session:tses_01KR9Z', kind: 'tab-session', label: 'ChatGPT — sidetrack' },
        empty,
        makeCtx(),
      );
      expect(display.primary).toBe('ChatGPT — sidetrack');
    });

    it('ignores id-like resolver labels', () => {
      const display = formatAnchorDisplay(
        { id: 'tab-session:tses_01KR9Z', kind: 'tab-session', label: 'tses_01KR9Z' },
        empty,
        makeCtx(),
      );
      // Resolver label is id-like → ignored → kind placeholder.
      expect(display.primary).toBe('Tab session');
      expect(display.primary).not.toContain('tses_');
    });
  });

  describe('visible-text contract', () => {
    // Catch-all assertion: every shape we render produces a primary
    // that never matches our internal-id patterns.
    const empty: ReadonlyMap<string, ConnectionNode> = new Map();
    const ctx = makeCtx();
    const cases: readonly string[] = [
      'tab-session:tses_01KR9ZY7VKFA38NF8Q87MGK2P0',
      'visit-instance:tses_01KR9Z:2026-05-10T22:12:35.297Z:https://chatgpt.com/g/x',
      'workstream:ZYJFNMTBZXBYP5DE',
      'thread:bac_abc',
      'replica:this-replica',
      'timeline-visit:https://example.com',
      'topic:bac_xyz',
      'weird:thing',
    ];
    for (const id of cases) {
      it(`never returns a raw-id-looking primary for ${id}`, () => {
        const display = formatNodeIdDisplay(id, empty, ctx);
        expect(display.primary).not.toMatch(/tses_[A-Z0-9]/);
        expect(display.primary).not.toMatch(/visit-instance:/);
        expect(display.primary).not.toMatch(/tab-session:/);
        expect(display.primary).not.toMatch(/^bac_/);
      });
    }
  });
});
