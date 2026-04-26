import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'BAC Local Bridge POC',
    description: 'PoC extension sensor for a local BAC vault writer companion.',
    permissions: ['nativeMessaging', 'sidePanel', 'storage'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    action: {
      default_title: 'BAC Local Bridge POC',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
