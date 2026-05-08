import { describe, expect, it } from 'vitest';

import { topicId } from './topicId.js';

describe('topicId', () => {
  it('produces the same id regardless of input order', async () => {
    const members = [
      'https://example.test/b',
      'https://example.test/a',
      'https://example.test/c',
    ];

    await expect(topicId(members)).resolves.toBe(
      await topicId([members[2]!, members[0]!, members[1]!]),
    );
  });

  it('changes when membership changes', async () => {
    const full = await topicId([
      'https://example.test/a',
      'https://example.test/b',
      'https://example.test/c',
    ]);
    const missingOne = await topicId([
      'https://example.test/a',
      'https://example.test/b',
    ]);

    expect(full).not.toBe(missingOne);
  });

  it('is cross-replica deterministic for the same canonical membership', async () => {
    const replicaA = [
      'https://docs.example.test/union-find',
      'https://docs.example.test/topic-lineage',
      'https://docs.example.test/context-pack',
    ];
    const replicaB = [
      'https://docs.example.test/context-pack',
      'https://docs.example.test/union-find',
      'https://docs.example.test/topic-lineage',
    ];

    const idA = await topicId(replicaA);
    const idB = await topicId(replicaB);

    expect(idA).toBe(idB);
    expect(idA).toMatch(/^topic:[A-Za-z0-9_-]{16}$/u);
  });
});
