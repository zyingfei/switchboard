import { describe, expect, it } from 'vitest';

import {
  formatEntityDisplay,
  type EntityDisplayCtx,
} from '../../../src/sidepanel/entityDisplay/format';
import type { ConnectionNode } from '../../../src/sidepanel/connections/types';

const ctx = (
  overrides: Partial<EntityDisplayCtx> = {},
): EntityDisplayCtx => ({
  resolveWorkstreamPath: () => null,
  replicaAlias: () => 'Browser',
  ...overrides,
});

const makeNode = (input: Partial<ConnectionNode> & { kind: ConnectionNode['kind']; id: string }) => ({
  label: '',
  originReplicaIds: [],
  metadata: {},
  ...input,
});

describe('formatEntityDisplay — inbound-reminder enrichment', () => {
  it('resolves the thread title via ctx.nodeById', () => {
    const thread = makeNode({
      kind: 'thread',
      id: 'thread:T1',
      metadata: { title: 'Netflix ArchUnit Scaling', provider: 'chatgpt' },
    });
    const reminder = makeNode({
      kind: 'inbound-reminder',
      id: 'inbound-reminder:R1',
      metadata: { threadId: 'thread:T1', provider: 'chatgpt', status: 'pending' },
    });
    const nodeById = new Map([[thread.id, thread]]);
    const display = formatEntityDisplay(reminder, ctx({ nodeById }));
    expect(display.primary).toBe('Reminder: Netflix ArchUnit Scaling');
    expect(display.secondary).toContain('pending');
  });

  it('falls back when threadId is missing — uses provider chip', () => {
    const reminder = makeNode({
      kind: 'inbound-reminder',
      id: 'inbound-reminder:R2',
      metadata: { provider: 'gemini', status: 'sent' },
    });
    const display = formatEntityDisplay(reminder, ctx());
    expect(display.primary).toBe('Reminder · gemini');
  });

  it('falls back when threadId is set but the thread is not in the snapshot', () => {
    const reminder = makeNode({
      kind: 'inbound-reminder',
      id: 'inbound-reminder:R3',
      metadata: { threadId: 'thread:absent', provider: 'claude', status: 'pending' },
    });
    const display = formatEntityDisplay(reminder, ctx({ nodeById: new Map() }));
    expect(display.primary).toBe('Reminder · claude');
  });

  it('resolves threadId without the `thread:` prefix too', () => {
    const thread = makeNode({
      kind: 'thread',
      id: 'thread:T2',
      metadata: { title: 'Casual Attrition 解释' },
    });
    const reminder = makeNode({
      kind: 'inbound-reminder',
      id: 'inbound-reminder:R4',
      metadata: { threadId: 'T2', status: 'pending' },
    });
    const nodeById = new Map([[thread.id, thread]]);
    const display = formatEntityDisplay(reminder, ctx({ nodeById }));
    expect(display.primary).toBe('Reminder: Casual Attrition 解释');
  });
});

describe('formatEntityDisplay — snippet metadata.match', () => {
  it('surfaces the copied text instead of the snippet_<hex> id', () => {
    const snippet = makeNode({
      kind: 'snippet',
      id: 'snippet:snippet_09696df0148b5907a28bab73',
      label: 'snippet_09696df0148b5907a28bab73',
      metadata: { match: 'CLOB matching engine', charHashPrefix: '09696' },
    });
    const display = formatEntityDisplay(snippet, ctx());
    expect(display.primary).toBe('CLOB matching engine');
  });

  it('falls back to "(snippet)" when no usable text is on the node', () => {
    const snippet = makeNode({
      kind: 'snippet',
      id: 'snippet:bare',
      label: 'snippet_bare',
      metadata: {},
    });
    const display = formatEntityDisplay(snippet, ctx());
    expect(display.primary).toBe('(snippet)');
  });
});
