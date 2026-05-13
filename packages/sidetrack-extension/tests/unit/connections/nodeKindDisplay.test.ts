import { describe, expect, it } from 'vitest';

import {
  NODE_KIND_DISPLAY,
  nodeKindDisplayFor,
} from '../../../src/sidepanel/connections/edgeKinds';

// Locks in the safe lookup contract. `types.ts` keeps the kind union
// intentionally loose because the companion is the source of truth
// for the wire shape — a new kind can land in the panel before the
// frontend's display map is updated. Before nodeKindDisplayFor
// existed, every `NODE_KIND_DISPLAY[kind]` lookup would crash with
// `undefined` on unknown kinds and take the whole view down with it.
describe('nodeKindDisplayFor', () => {
  it('returns the registered display for known kinds', () => {
    expect(nodeKindDisplayFor('workstream')).toEqual(NODE_KIND_DISPLAY['workstream']);
    expect(nodeKindDisplayFor('timeline-visit')).toEqual(NODE_KIND_DISPLAY['timeline-visit']);
  });

  it('falls back to "Unknown" + a neutral tint for unfamiliar kinds', () => {
    const display = nodeKindDisplayFor('snippet-cluster-future-feature');
    expect(display.label).toBe('Unknown');
    expect(display.tintClass).toBe('cx-type-unknown');
  });

  it('never throws on an empty string', () => {
    expect(() => nodeKindDisplayFor('')).not.toThrow();
    expect(nodeKindDisplayFor('').label).toBe('Unknown');
  });
});
