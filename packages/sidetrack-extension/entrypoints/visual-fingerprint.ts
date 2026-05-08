import { defineContentScript } from 'wxt/utils/define-content-script';

import { startVisualFingerprinting } from '../src/content/visual/dom-hash';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    startVisualFingerprinting();
  },
});

