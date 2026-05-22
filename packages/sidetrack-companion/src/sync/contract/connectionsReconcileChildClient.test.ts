import { describe, expect, it } from 'vitest';

import { buildReconcileChildEnv } from './connectionsReconcileChildClient.js';

describe('reconcile child env', () => {
  it('forwards the connections store mode into the child process env', () => {
    expect(
      buildReconcileChildEnv({
        PATH: '/bin',
        SIDETRACK_CONNECTIONS_STORE: 'json',
      })['SIDETRACK_CONNECTIONS_STORE'],
    ).toBe('json');
  });
});
