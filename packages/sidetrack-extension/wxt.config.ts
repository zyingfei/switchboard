import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { defineConfig } from 'wxt';

// Build-time identity injected as __BUILD_INFO__ into the bundle.
// Used by the side panel's footer line so the user can confirm the
// loaded extension matches their git state at a glance.
const here = dirname(fileURLToPath(import.meta.url));
const pkgVersion = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as {
      readonly version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const gitSha = ((): string => {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
})();
const buildInfo = {
  version: pkgVersion,
  sha: gitSha,
  builtAt: new Date().toISOString(),
};

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      __BUILD_INFO__: JSON.stringify(buildInfo),
    },
  }),
  manifest: {
    name: 'Sidetrack',
    description: 'Local-first browser AI work tracker.',
    permissions: ['activeTab', 'sidePanel', 'storage', 'scripting'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: 'Sidetrack',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
