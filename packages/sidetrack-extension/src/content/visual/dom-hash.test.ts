import { describe, expect, it } from 'vitest';

import {
  canonicalDomSkeletonForElement,
  domSkeletonHash,
  emitVisualFingerprintOnce,
} from './dom-hash';

const buildFixture = (variant: 'alpha' | 'bravo'): HTMLElement => {
  const root = document.createElement('main');
  root.id = variant === 'alpha' ? 'root-a' : 'root-b';
  root.className = variant === 'alpha' ? 'layout-a' : 'layout-b';

  const section = document.createElement('section');
  section.className = variant === 'alpha' ? 'hero' : 'panel';
  const heading = document.createElement('h1');
  heading.append(document.createTextNode(variant === 'alpha' ? 'First title' : 'Second title'));
  const link = document.createElement('a');
  link.setAttribute('href', variant === 'alpha' ? '/one' : '/two');
  link.append(document.createTextNode(variant === 'alpha' ? 'Open one' : 'Open two'));

  section.append(heading, link);
  root.append(section);
  return root;
};

describe('DOM skeleton fingerprinting', () => {
  it('hashes the same tag skeleton equally when copy and attribute values differ', async () => {
    const first = buildFixture('alpha');
    const second = buildFixture('bravo');

    expect(canonicalDomSkeletonForElement(first)).toBe(canonicalDomSkeletonForElement(second));
    await expect(domSkeletonHash(first)).resolves.toBe(await domSkeletonHash(second));
  });

  it('does not emit when the visual fingerprint privacy gate is closed', async () => {
    const sent: unknown[] = [];
    const emitted = await emitVisualFingerprintOnce({
      root: buildFixture('alpha'),
      locationHref: 'https://example.test/page#fragment',
      now: () => new Date('2026-05-08T12:00:00.000Z'),
      isPrivacyGateOpen: async () => false,
      send: (message) => sent.push(message),
    });

    expect(emitted).toBe(false);
    expect(sent).toEqual([]);
  });
});
