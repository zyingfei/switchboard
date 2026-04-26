import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'BAC Provider Capture POC',
    description: 'On-demand visible thread capture from ChatGPT, Claude, and Gemini tabs.',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3Vvs4vjwrkqaXczAmP6wQVO3fTV2X6AEVfXAR6IbL6tTx//poIw8JPQYNe0bYGvCF8t2txNUrdMj4aEzyvsN54Ul7qc20I9BxGfRWvM7pCOD1irvHrqyP5B8IePdKjB8B3tuxpwIgj5QcgbFZlmHY+qrlJ07NNEFJQj9XuNKrMc6tlIwIPpKDcfDjvVEhxAmbJ5OSn8B1UExRzAPaXYn1kdBI7Lwnu3SXxL1Z4q0HyprG0wmqeHvZNXdIpBMJaK6nrIaJP131t0sqA4Ocno9oYnXV/J9uK5qOvpvnBonWiqGzt5EibXMMCyZjVjkdx2bAk+80MtBYo1SvkvyppWP5wIDAQAB',
    permissions: ['activeTab', 'sidePanel', 'scripting', 'storage', 'tabs'],
    action: {
      default_title: 'BAC Provider Capture POC',
    },
    commands: {
      'capture-active-tab': {
        suggested_key: {
          default: 'Ctrl+Shift+Y',
          mac: 'MacCtrl+Shift+Y',
        },
        description: 'Capture the active provider tab locally',
      },
    },
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://*.oaiusercontent.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*'
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
