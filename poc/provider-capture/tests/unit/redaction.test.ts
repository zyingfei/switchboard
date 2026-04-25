import { describe, expect, it } from 'vitest';
import { buildCaptureWarnings } from '../../src/capture/redaction';

describe('redaction warnings', () => {
  it('warns on obvious secrets, email addresses, and private URLs in visible browser content', () => {
    const warnings = buildCaptureWarnings(
      'Contact owner@example.com with sk-abcdefghijklmnopqrstuvwxyz123456 or see http://localhost:3000/admin.',
      'https://chatgpt.com/c/test',
    );

    expect(warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['possible_api_key', 'email', 'internal_url']),
    );
  });
});
