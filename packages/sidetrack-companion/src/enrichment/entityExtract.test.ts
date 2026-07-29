import { describe, expect, it } from 'bun:test';

import {
  ENTITY_MAX_PER_GIST,
  ENTITY_NAME_MAX_LENGTH,
  categoryKind,
  entityKeyFor,
  extractEntities,
  normalizeEntityName,
} from './entityExtract.js';

// WHY THIS FILE IS LONG. The parser's input is MODEL PROSE — the one input
// class nobody gets to specify. Every case below is a shape observed in (or
// directly adjacent to) live gists, and each pins a decision that would
// otherwise be silently re-litigated the next time someone touches a
// heuristic: what ends the section, what is a category vs a gloss, what is a
// placeholder, and what a period means.

const names = (gist: string): readonly string[] =>
  extractEntities(gist).entities.map((e) => e.name);

describe('extractEntities — observed gist shapes', () => {
  it('parses the inline comma list (the most common live shape)', () => {
    const result = extractEntities(
      'The article reports a security disclosure.\n\n' +
        'Key Entities: JFrog, OpenAI, zero-day security, cyber models, ' +
        'software supply chain attacks.',
    );
    expect(result.found).toBe(true);
    expect(result.entities.map((e) => e.name)).toEqual([
      'JFrog',
      'OpenAI',
      'zero-day security',
      'cyber models',
      'software supply chain attacks',
    ]);
    // The list's terminating period is stripped by normalization, not by the
    // sentence cut — nothing was lost.
    expect(result.dropped).toBe(0);
  });

  it('parses a "### Key Entities" heading with labelled sublists', () => {
    const result = extractEntities(
      'A note about lock-free programming.\n\n' +
        '### Key Entities\n' +
        '- People/Organizations: None explicitly mentioned.\n' +
        '- Technologies: Modern C++, inline functions, hazard pointers.\n',
    );
    expect(result.found).toBe(true);
    expect(result.entities).toEqual([
      { name: 'Modern C++', kind: 'tech' },
      { name: 'inline functions', kind: 'tech' },
      { name: 'hazard pointers', kind: 'tech' },
    ]);
  });

  it('treats "None explicitly mentioned" as EMPTY, not as an entity named None', () => {
    const result = extractEntities('Key Entities: None explicitly mentioned.');
    expect(result.found).toBe(true);
    expect(result.entities).toEqual([]);
    // A placeholder is the model answering honestly — nothing was dropped.
    expect(result.dropped).toBe(0);
  });

  it('distinguishes NO SECTION from an empty section (typed emptiness)', () => {
    const absent = extractEntities('A summary with no entity section at all.');
    expect(absent.found).toBe(false);
    expect(absent.entities).toEqual([]);
    expect(extractEntities('').found).toBe(false);
  });

  it('cuts the list where the prose resumes on the same line', () => {
    expect(
      names('Key Entities: JFrog, OpenAI. The article argues that supply chains matter.'),
    ).toEqual(['JFrog', 'OpenAI']);
  });

  it('does not cut on a period INSIDE a name (no following space)', () => {
    expect(names('Key Entities: Node.js, React 18, GPT-4.5.')).toEqual([
      'Node.js',
      'React 18',
      'GPT-4.5',
    ]);
  });

  it('reads through markdown emphasis on the header', () => {
    expect(names('**Key Entities:** Alpha, Beta')).toEqual(['Alpha', 'Beta']);
  });

  it('accepts a bare "Entities:" label but never the word in prose', () => {
    expect(names('Summary line.\nEntities: Alpha, Beta')).toEqual(['Alpha', 'Beta']);
    // The bare word is everywhere in ordinary summaries; matching it
    // mid-sentence would comma-split a sentence into fake entities.
    expect(extractEntities('The entities involved are unclear, sadly.').found).toBe(false);
    expect(extractEntities('Entities involved: Alpha, Beta').found).toBe(false);
  });

  it('parses an unlabelled dash list, a numbered list, and a bare next line', () => {
    expect(names('Key Entities:\n- Alpha\n- Beta\n')).toEqual(['Alpha', 'Beta']);
    expect(names('Key Entities:\n1. Alpha\n2) Beta\n')).toEqual(['Alpha', 'Beta']);
    expect(names('Key Entities\nAlpha, Beta')).toEqual(['Alpha', 'Beta']);
  });

  it('handles "A, B, and C" and semicolon-separated lists', () => {
    expect(names('Key Entities: Alpha, Beta, and Gamma')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(names('Key Entities: Alpha; Beta; Gamma')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('extractEntities — where the section ends', () => {
  it('stops at a blank line once entities have been read', () => {
    expect(names('Key Entities: Alpha, Beta\n\nThis page also covers gamma, delta.')).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  it('allows a blank line BEFORE the list (heading, blank, bullets)', () => {
    expect(names('### Key Entities\n\n- Alpha\n- Beta\n')).toEqual(['Alpha', 'Beta']);
  });

  it('stops at the next markdown heading', () => {
    expect(names('### Key Entities\n- Alpha\n### Notes\n- Beta\n')).toEqual(['Alpha']);
  });

  it('stops at a prose line following the bullets', () => {
    expect(names('Key Entities:\n- Alpha\nThese are the main topics, broadly.')).toEqual([
      'Alpha',
    ]);
  });
});

describe('extractEntities — categories vs glosses', () => {
  it('maps a combined label to the bucket that appears first', () => {
    expect(categoryKind('People/Organizations')).toBe('people');
    expect(categoryKind('Organizations and people')).toBe('org');
    expect(categoryKind('Key technologies')).toBe('tech');
    expect(categoryKind('Open questions')).toBe('question');
    expect(categoryKind('Concepts')).toBe('topic');
    expect(categoryKind('Miscellaneous')).toBeUndefined();
  });

  it('reads "Name: gloss" as the NAME (a gloss is prose, not an entity)', () => {
    expect(names('Key Entities:\n- JFrog: the artifact repository company')).toEqual(['JFrog']);
  });

  it('reads an UNKNOWN label with a comma list as a list, dropping the label', () => {
    expect(names('Key Entities:\n- Miscellaneous: Alpha, Beta')).toEqual(['Alpha', 'Beta']);
  });

  it('upgrades an uncategorized entity when a later line categorizes it', () => {
    const result = extractEntities('Key Entities: OpenAI\n- Organizations: OpenAI\n');
    expect(result.entities).toEqual([{ name: 'OpenAI', kind: 'org' }]);
  });
});

describe('extractEntities — bounds, dedupe, normalization', () => {
  it('dedupes case-insensitively and keeps the FIRST spelling for display', () => {
    const result = extractEntities('Key Entities: OpenAI, openai, OPENAI');
    expect(result.entities.map((e) => e.name)).toEqual(['OpenAI']);
    expect(result.dropped).toBe(0);
  });

  it('drops over-long and too-short candidates AND counts them', () => {
    const long = 'x'.repeat(ENTITY_NAME_MAX_LENGTH + 1);
    const result = extractEntities(`Key Entities: Alpha, ${long}, A`);
    expect(result.entities.map((e) => e.name)).toEqual(['Alpha']);
    expect(result.dropped).toBe(2);
  });

  it('caps at ENTITY_MAX_PER_GIST and reports the overflow rather than hiding it', () => {
    const many = Array.from({ length: ENTITY_MAX_PER_GIST + 5 }, (_, i) => `Ent${String(i)}`);
    const result = extractEntities(`Key Entities: ${many.join(', ')}`);
    expect(result.entities.length).toBe(ENTITY_MAX_PER_GIST);
    expect(result.dropped).toBe(5);
  });

  it('collapses whitespace and strips quotes, emphasis and trailing punctuation', () => {
    expect(normalizeEntityName('  Alpha   Beta  ')).toBe('Alpha Beta');
    expect(normalizeEntityName('"Alpha Beta"')).toBe('Alpha Beta');
    expect(normalizeEntityName('**Gamma.**')).toBe('Gamma');
    expect(normalizeEntityName('`code`;')).toBe('code');
    // C++ keeps its plusses — they are part of the name, not punctuation.
    expect(normalizeEntityName('Modern C++,')).toBe('Modern C++');
  });

  it('keys names case-insensitively so lookup and fold cannot drift', () => {
    expect(entityKeyFor('  OpenAI. ')).toBe('openai');
    expect(entityKeyFor('**Modern C++**')).toBe('modern c++');
  });

  it('ignores empty segments without counting them as drops', () => {
    const result = extractEntities('Key Entities: Alpha, , Beta');
    expect(result.entities.map((e) => e.name)).toEqual(['Alpha', 'Beta']);
    expect(result.dropped).toBe(0);
  });

  it('is linear on a degenerate repeated gist (the retraction-class input)', () => {
    // The repetition-loop gists that forced the retraction route exist in the
    // live vault; the parser must not spin on one.
    const loop = `Key Entities: ${"It's a long story, ".repeat(400)}end`;
    const started = Date.now();
    const result = extractEntities(loop);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.entities.length).toBeLessThanOrEqual(ENTITY_MAX_PER_GIST);
  });
});
