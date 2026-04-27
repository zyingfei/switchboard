import { describe, expect, it } from 'vitest';

import { redact } from './redaction.js';

describe('redact', () => {
  it('redacts email addresses', () => {
    expect(redact('Contact owner@example.com for access.')).toEqual({
      output: 'Contact [email] for access.',
      matched: 1,
      categories: ['email'],
    });
  });

  it('redacts GitHub tokens', () => {
    const result = redact(`token ghp_${'a'.repeat(36)}`);

    expect(result.output).toBe('token [github-token]');
    expect(result.categories).toEqual(['github-token']);
    expect(result.matched).toBe(1);
  });

  it('redacts OpenAI keys', () => {
    const result = redact(`openai sk-${'A'.repeat(40)}`);

    expect(result.output).toBe('openai [openai-key]');
    expect(result.categories).toEqual(['openai-key']);
    expect(result.matched).toBe(1);
  });

  it('redacts Anthropic keys', () => {
    const result = redact(`anthropic sk-ant-${'b'.repeat(32)}`);

    expect(result.output).toBe('anthropic [anthropic-key]');
    expect(result.categories).toEqual(['anthropic-key']);
    expect(result.matched).toBe(1);
  });

  it('redacts bearer tokens and authorization headers', () => {
    const result = redact('Authorization: Bearer abcdefgh12345678');

    expect(result.output).toBe('[bearer-token]');
    expect(result.categories).toEqual(['bearer-token']);
    expect(result.matched).toBe(1);
  });

  it('redacts loose card numbers', () => {
    const result = redact('card 4242 4242 4242 4242');

    expect(result.output).toBe('card [card-number]');
    expect(result.categories).toEqual(['card-number']);
    expect(result.matched).toBe(1);
  });

  it('returns no matches for ordinary text', () => {
    expect(redact('No secrets in this dispatch.')).toEqual({
      output: 'No secrets in this dispatch.',
      matched: 0,
      categories: [],
    });
  });

  it('reports multiple categories in one input', () => {
    const result = redact(`Email a@example.com and use sk-${'C'.repeat(40)} with 4111111111111111`);

    expect(result.output).toBe('Email [email] and use [openai-key] with [card-number]');
    expect(result.matched).toBe(3);
    expect(result.categories).toEqual(['openai-key', 'email', 'card-number']);
  });
});
