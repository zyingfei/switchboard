import { describe, expect, it } from 'vitest';

import { selectActiveRevision } from './manifest.js';

// Lane 2 — active-revision policy. Verifies:
//   L2-G5 (concurrent extraction revisions → both replicas pick the
//          same active revision deterministically).

describe('selectActiveRevision', () => {
  it('returns undefined when all candidates are tombstoned', () => {
    expect(
      selectActiveRevision([
        {
          extractionRevisionId: 'a',
          extractorId: 'legacy',
          extractorVersion: '0.0.0',
          extractionSchemaVersion: 1,
          tombstoned: true,
        },
      ]),
    ).toBeUndefined();
  });

  it('prefers higher extractionSchemaVersion over higher semver', () => {
    const winner = selectActiveRevision([
      {
        extractionRevisionId: 'a',
        extractorId: 'legacy',
        extractorVersion: '99.0.0',
        extractionSchemaVersion: 1,
      },
      {
        extractionRevisionId: 'b',
        extractorId: 'legacy',
        extractorVersion: '0.0.0',
        extractionSchemaVersion: 2,
      },
    ]);
    expect(winner?.extractionRevisionId).toBe('b');
  });

  it('prefers higher semver when extractorId matches; uses proper compare not lex', () => {
    const winner = selectActiveRevision([
      {
        extractionRevisionId: 'a',
        extractorId: 'legacy',
        extractorVersion: '1.10.0',
        extractionSchemaVersion: 1,
      },
      {
        extractionRevisionId: 'b',
        extractorId: 'legacy',
        extractorVersion: '1.2.0',
        extractionSchemaVersion: 1,
      },
    ]);
    // 1.10.0 > 1.2.0 in semver (NOT lex, where '1.2.0' > '1.10.0').
    expect(winner?.extractionRevisionId).toBe('a');
  });

  it('deterministic tie-break by (replicaId, dot.seq) when nothing else differs', () => {
    const candidates = [
      {
        extractionRevisionId: 'a',
        extractorId: 'legacy',
        extractorVersion: '0.0.0',
        extractionSchemaVersion: 1,
        producerDot: { replicaId: 'replica-B', seq: 1 },
      },
      {
        extractionRevisionId: 'b',
        extractorId: 'legacy',
        extractorVersion: '0.0.0',
        extractionSchemaVersion: 1,
        producerDot: { replicaId: 'replica-A', seq: 1 },
      },
    ];
    // 'replica-A' < 'replica-B' lexicographically — wins.
    const winner = selectActiveRevision(candidates);
    expect(winner?.extractionRevisionId).toBe('b');
    // Result must be invariant to candidate order.
    const reversed = selectActiveRevision([candidates[1]!, candidates[0]!]);
    expect(reversed?.extractionRevisionId).toBe('b');
  });
});
