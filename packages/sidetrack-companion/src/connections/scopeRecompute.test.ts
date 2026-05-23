import { describe, expect, it } from 'vitest';

import { buildMultiFlowFixture } from './__fixtures__/multiFlowStory.js';
import { buildConnectionsSnapshot } from './snapshot.js';
import {
  recomputeScope,
  scopesForConnectionsSnapshot,
  unionScopeOutputs,
} from './scopeRecompute.js';

describe('connections scope recompute helpers', () => {
  it('unions all scope outputs to the full snapshot rows', () => {
    const input = buildMultiFlowFixture();
    const full = buildConnectionsSnapshot(input);
    const scopes = scopesForConnectionsSnapshot(full);
    const scoped = unionScopeOutputs(scopes.map((scope) => recomputeScope(scope, full)));

    expect(scoped.nodes).toEqual(full.nodes);
    expect(scoped.edges).toEqual(full.edges);
  });
});
