import '@testing-library/jest-dom/vitest';

// __BUILD_INFO__ is injected by Vite's `define` (see wxt.config.ts)
// at build time. Vitest doesn't run through that pipeline, so we
// stub it here for tests so any component that reads it gets a
// stable value instead of a ReferenceError.
(globalThis as { __BUILD_INFO__?: unknown }).__BUILD_INFO__ = {
  version: '0.0.0-test',
  sha: 'test',
  builtAt: '2026-04-30T00:00:00.000Z',
};
(globalThis as { __DEV__?: unknown }).__DEV__ = true;

// The Apple on-device engine probes a LOOPBACK PORT to decide whether it
// exists. Left alone, that makes every test's result depend on whether
// `apfel --serve` happens to be running on the machine — observed for real on
// 2026-07-28, when five unrelated engine/remote tests failed with
// "expected 'apple' to be 'none'" simply because the service was up in another
// terminal. CI, having no service, would have stayed green and hidden it.
//
// So the probe is stubbed ABSENT for the whole suite. Hermetic by default; a
// test that wants the Apple engine available calls setAppleProbeForTest()
// itself, which makes that dependency visible in the test rather than ambient.
import { setAppleProbeForTest } from '../src/sidepanel/nano/engine';
import { APPLE_SERVICE_ABSENT } from '../src/sidepanel/nano/appleService';

setAppleProbeForTest(() => Promise.resolve(APPLE_SERVICE_ABSENT));
