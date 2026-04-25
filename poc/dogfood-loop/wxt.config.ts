import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Browser AI Companion POC',
    description: 'Local-first POC for forking notes into mock chat targets and converging responses.',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3Vvs4vjwrkqaXczAmP6wQVO3fTV2X6AEVfXAR6IbL6tTx//poIw8JPQYNe0bYGvCF8t2txNUrdMj4aEzyvsN54Ul7qc20I9BxGfRWvM7pCOD1irvHrqyP5B8IePdKjB8B3tuxpwIgj5QcgbFZlmHY+qrlJ07NNEFJQj9XuNKrMc6tlIwIPpKDcfDjvVEhxAmbJ5OSn8B1UExRzAPaXYn1kdBI7Lwnu3SXxL1Z4q0HyprG0wmqeHvZNXdIpBMJaK6nrIaJP131t0sqA4Ocno9oYnXV/J9uK5qOvpvnBonWiqGzt5EibXMMCyZjVjkdx2bAk+80MtBYo1SvkvyppWP5wIDAQAB',
    permissions: ['sidePanel', 'storage', 'tabs'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
