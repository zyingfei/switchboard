import { describe, expect, it } from 'vitest';

import fullFixture from './__fixtures__/context-pack-full.json';
import omitFixture from './__fixtures__/context-pack-omit-sections.json';
import { buildContextPack, extractOpenQuestions, type ContextPackInput } from './contextPack';

describe('buildContextPack', () => {
  it('renders all sections from the full fixture', () => {
    const markdown = buildContextPack(fullFixture as ContextPackInput);

    expect(markdown).toContain('## Topic');
    expect(markdown).toContain('## Threads');
    expect(markdown).toContain('## Dispatches');
    expect(markdown).toContain('## Snippets');
    expect(markdown).toContain('## Open Questions');
  });

  it('omits empty sections', () => {
    const markdown = buildContextPack(omitFixture as ContextPackInput);

    expect(markdown).toContain('## Topic');
    expect(markdown).not.toContain('## Dispatches');
    expect(markdown).not.toContain('## Open Questions');
  });

  it('extracts open questions from user notes only', () => {
    expect(extractOpenQuestions((fullFixture as ContextPackInput).userNotes)).toEqual([
      'Can this run without a network call?',
      'What should the pack include?',
    ]);
    expect(extractOpenQuestions((omitFixture as ContextPackInput).userNotes)).toEqual([]);
  });

  it('renders hash-only and raw snippets deterministically', () => {
    const markdown = buildContextPack(fullFixture as ContextPackInput);

    expect(markdown).toContain('snippet:a: (hashed) #hash-a');
    expect(markdown).toContain(
      'snippet:b: This is the exact source snippet that should be truncated after eighty character...',
    );
  });

  it('is byte-deterministic', () => {
    const first = buildContextPack(fullFixture as ContextPackInput);
    const second = buildContextPack(fullFixture as ContextPackInput);

    expect(first).toBe(second);
  });
});
