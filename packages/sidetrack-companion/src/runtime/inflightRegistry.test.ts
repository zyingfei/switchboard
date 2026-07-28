import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetInflightRegistry,
  completeInflight,
  droppedInflightRegistrations,
  formatInflightForLog,
  inflightCount,
  registerInflight,
  routeLabelFromPattern,
  snapshotInflight,
} from './inflightRegistry.js';

// Module-level state is process-global; every test starts from empty.
afterEach(() => {
  __resetInflightRegistry();
});

describe('inflightRegistry register/complete', () => {
  it('tracks a request between register and complete', () => {
    expect(inflightCount()).toBe(0);
    const id = registerInflight('GET:/v1/status');
    expect(inflightCount()).toBe(1);
    expect(snapshotInflight().map((entry) => entry.route)).toEqual(['GET:/v1/status']);
    completeInflight(id);
    expect(inflightCount()).toBe(0);
    expect(snapshotInflight()).toEqual([]);
  });

  it('completing is idempotent and tolerates unknown / untracked ids', () => {
    const id = registerInflight('GET:/v1/status');
    completeInflight(id);
    // A double-complete (dispatch `finally` plus a defensive caller) and a
    // never-issued id must both be no-ops — a diagnostic must not be able to
    // throw inside somebody else's `finally`.
    expect(() => {
      completeInflight(id);
    }).not.toThrow();
    expect(() => {
      completeInflight(999_999);
    }).not.toThrow();
    expect(() => {
      completeInflight(0);
    }).not.toThrow();
    expect(inflightCount()).toBe(0);
  });

  it('two requests on the same route are tracked independently', () => {
    const first = registerInflight('POST:/v1/visits/batch-resolve');
    const second = registerInflight('POST:/v1/visits/batch-resolve');
    expect(inflightCount()).toBe(2);
    completeInflight(first);
    expect(inflightCount()).toBe(1);
    completeInflight(second);
    expect(inflightCount()).toBe(0);
  });
});

describe('inflightRegistry snapshot ordering + bounds', () => {
  it('orders longest-running first', async () => {
    const oldest = registerInflight('POST:/v1/visits/batch-resolve');
    // Real elapsed time, not a fake clock: the registry reads Date.now() at
    // register AND at snapshot, so the ages have to actually differ.
    await new Promise((resolve) => setTimeout(resolve, 12));
    registerInflight('GET:/v1/status');
    const entries = snapshotInflight();
    expect(entries.map((entry) => entry.route)).toEqual([
      'POST:/v1/visits/batch-resolve',
      'GET:/v1/status',
    ]);
    expect(entries[0]!.ageMs).toBeGreaterThanOrEqual(entries[1]!.ageMs);
    completeInflight(oldest);
  });

  it('bounds the output — never dumps the whole table into a log line', () => {
    for (let index = 0; index < 40; index += 1) {
      registerInflight(`GET:/v1/route-${String(index)}`);
    }
    expect(inflightCount()).toBe(40);
    // Default limit is the 3 the stall line asks for.
    expect(snapshotInflight()).toHaveLength(3);
    expect(snapshotInflight(5)).toHaveLength(5);
    // A caller asking for more than exist gets what exists, not padding.
    expect(snapshotInflight(1000)).toHaveLength(40);
    expect(snapshotInflight(0)).toEqual([]);
    expect(snapshotInflight(-1)).toEqual([]);
  });

  it('caps tracked registrations rather than growing without bound', () => {
    // A `complete()` leak must degrade to "attribution stops working", never to
    // an unbounded Map. 600 > the 512 cap.
    for (let index = 0; index < 600; index += 1) {
      registerInflight('GET:/v1/leaky');
    }
    expect(inflightCount()).toBe(512);
    expect(droppedInflightRegistrations()).toBe(88);
    // Over-cap registrations return the untracked id 0, so callers still work.
    expect(registerInflight('GET:/v1/leaky')).toBe(0);
  });
});

describe('formatInflightForLog', () => {
  it('renders `none` when nothing is running', () => {
    expect(formatInflightForLog()).toBe('none');
  });

  it('renders route:ageMs pipe-separated, with no spaces (log-line safe)', () => {
    registerInflight('POST:/v1/visits/batch-resolve');
    registerInflight('GET:/v1/status');
    const line = formatInflightForLog();
    expect(line).toContain('POST:/v1/visits/batch-resolve:');
    expect(line).toContain('GET:/v1/status:');
    expect(line).toContain('|');
    expect(line).toMatch(/ms$/u);
    // The stall line is space-separated key=value; a space inside the value
    // would break every grep/awk an operator writes against it.
    expect(line).not.toContain(' ');
  });

  it('renders at most the requested number of entries', () => {
    for (let index = 0; index < 10; index += 1) {
      registerInflight(`GET:/v1/route-${String(index)}`);
    }
    expect(formatInflightForLog(3).split('|')).toHaveLength(3);
    expect(formatInflightForLog(1).split('|')).toHaveLength(1);
  });
});

describe('routeLabelFromPattern', () => {
  it('renders a literal route as METHOD:/path', () => {
    expect(routeLabelFromPattern('GET', /^\/v1\/status$/)).toBe('GET:/v1/status');
    expect(routeLabelFromPattern('POST', /^\/v1\/visits\/batch-resolve$/u)).toBe(
      'POST:/v1/visits/batch-resolve',
    );
  });

  it('keeps a named capture group as {name}', () => {
    expect(routeLabelFromPattern('GET', /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u)).toBe(
      'GET:/v1/visits/{canonicalUrl}/resolve',
    );
    expect(
      routeLabelFromPattern('POST', /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/attribute$/u),
    ).toBe('POST:/v1/tabsessions/{tabSessionId}/attribute');
  });

  it('renders an unnamed character-class parameter as {param}', () => {
    expect(routeLabelFromPattern('POST', /^\/v1\/threads\/[A-Za-z0-9_-]+\/archive$/)).toBe(
      'POST:/v1/threads/{param}/archive',
    );
  });

  it('is derived from the PATTERN, so no request URL can leak into a log', () => {
    // The load-bearing privacy property: the label for the resolve route is the
    // same string no matter which page is being resolved, because the request
    // URL is never an input. url.pathname for this route CONTAINS the encoded
    // canonical URL — which is exactly why the http-log's "strip the query
    // string" rule is not sufficient here.
    const label = routeLabelFromPattern('GET', /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u);
    expect(label).not.toContain('http');
    expect(label).not.toContain('%');
    // Format contract: the ONLY colon is the METHOD separator, so `:<n>ms` is
    // unambiguously the age. And no spaces, ever.
    expect(label.split(':')).toHaveLength(2);
    expect(label).not.toContain(' ');
  });

  it('strips stray regex metacharacters (whitelist pass, future-proof)', () => {
    // A pattern shape nobody has written yet must still produce a clean label.
    const label = routeLabelFromPattern('GET', /^\/v1\/(?:a|b)\/x\.json$/u);
    expect(label).toMatch(/^GET:[A-Za-z0-9/_\-.{}]+$/u);
    expect(label).not.toContain('\\');
    expect(label).not.toContain('|');
    expect(label).not.toContain('$');
  });

  it('memoizes by (method, source) — same input, same string', () => {
    const pattern = /^\/v1\/status$/;
    expect(routeLabelFromPattern('GET', pattern)).toBe(routeLabelFromPattern('GET', pattern));
    expect(routeLabelFromPattern('GET', pattern)).not.toBe(routeLabelFromPattern('POST', pattern));
  });
});
