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

  it('redacts loose card numbers with space grouping (Luhn-valid)', () => {
    // 4242 4242 4242 4242 is Luhn-valid and card-grouped.
    const result = redact('card 4242 4242 4242 4242');

    expect(result.output).toBe('card [card-number]');
    expect(result.categories).toEqual(['card-number']);
    expect(result.matched).toBe(1);
  });

  it('redacts compact card number (no separator, Luhn-valid)', () => {
    // 4111111111111111 is a standard Luhn-valid test card.
    const result = redact('charge 4111111111111111 now');

    expect(result.output).toBe('charge [card-number] now');
    expect(result.categories).toEqual(['card-number']);
    expect(result.matched).toBe(1);
  });

  it('does NOT redact a Discord/Twitter snowflake (16 digits, Luhn-invalid, no card grouping)', () => {
    // 175928847299117063 is a real Discord snowflake — 18 digits, Luhn-invalid.
    const result = redact('user id 175928847299117063 joined');

    expect(result.output).toBe('user id 175928847299117063 joined');
    expect(result.matched).toBe(0);
  });

  it('does NOT redact a 16-digit epoch-nanos timestamp (Luhn-invalid)', () => {
    // 1720627200000000000 is 19 digits (out of 13-19 range) — but let us
    // also test a 16-digit nanos value that is Luhn-invalid.
    // We construct one that is 16 digits but fails Luhn.
    // 1234567890123456 — last digit chosen so Luhn fails.
    const result = redact('ts=1234567890123456');

    // Should pass through: Luhn check fails for this value and no card grouping.
    expect(result.output).toBe('ts=1234567890123456');
    expect(result.matched).toBe(0);
  });

  it('does NOT redact a 17-digit numeric id (Luhn-invalid, no card grouping)', () => {
    const result = redact('order_id=12345678901234567');

    expect(result.output).toBe('order_id=12345678901234567');
    expect(result.matched).toBe(0);
  });

  it('does NOT redact an 18-digit numeric id (Luhn-invalid, no card grouping)', () => {
    const result = redact('snowflake: 175928847299117063');

    expect(result.output).toBe('snowflake: 175928847299117063');
    expect(result.matched).toBe(0);
  });

  it('does NOT redact a 19-digit numeric id (Luhn-invalid, no card grouping)', () => {
    const result = redact('event_id=1234567890123456789');

    expect(result.output).toBe('event_id=1234567890123456789');
    expect(result.matched).toBe(0);
  });

  it('redacts AWS access key ids', () => {
    const result = redact('key AKIAIOSFODNN7EXAMPLE end');

    expect(result.output).toBe('key [aws-access-key] end');
    expect(result.categories).toEqual(['aws-access-key']);
    expect(result.matched).toBe(1);
  });

  it('redacts labelled AWS secret access keys', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const result = redact(`aws_secret_access_key=${secret}`);

    expect(result.output).toBe('aws_secret_access_key=[aws-secret-key]');
    expect(result.categories).toEqual(['aws-secret-key']);
    expect(result.matched).toBe(1);
  });

  it('redacts US social security numbers', () => {
    const result = redact('SSN 123-45-6789 on file');

    expect(result.output).toBe('SSN [ssn] on file');
    expect(result.categories).toEqual(['ssn']);
    expect(result.matched).toBe(1);
  });

  it('redacts phone numbers', () => {
    const result = redact('call (415) 555-0134 today');

    expect(result.output).toBe('call [phone] today');
    expect(result.categories).toEqual(['phone']);
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
    // card-number fires before the rules loop, so its order in categories may
    // differ — use arrayContaining rather than exact order.
    expect(result.categories).toEqual(expect.arrayContaining(['openai-key', 'email', 'card-number']));
    expect(result.categories).toHaveLength(3);
  });
});
