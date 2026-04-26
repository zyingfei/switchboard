import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Sidetrack',
    description: 'Local-first browser AI work tracker.',
    permissions: ['activeTab', 'sidePanel', 'storage'],
    optional_host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
      'https://*/*',
      'http://*/*',
    ],
    action: {
      default_title: 'Sidetrack',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
