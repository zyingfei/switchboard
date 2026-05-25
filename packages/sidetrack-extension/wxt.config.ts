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
// Uncommitted local edits = dirty. Without this flag the version banner
// kept showing the last committed sha even after rebuilds layered fresh
// changes on top — operators had no way to tell "this bundle includes
// my WIP edit" from "this bundle is the released sha". The output of
// `git status --porcelain` is empty iff the worktree is clean.
const gitDirty = ((): boolean => {
  try {
    const status = execSync('git status --porcelain', {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
})();
const buildInfo = {
  version: pkgVersion,
  sha: gitDirty ? `${gitSha}-dirty` : gitSha,
  builtAt: new Date().toISOString(),
};

// Encode the build time into the Chrome manifest version so the
// chrome://extensions/ page surfaces it directly. Chrome manifest
// versions allow up to four dot-separated integers, each 0–65535.
// Format: 0.<YY>.<MMDD>.<HHMM> — e.g. "0.26.0511.1410" =
// 2026-05-11 14:10. The pkg.json version stays 0.0.0 — the runtime
// banner already shows that alongside sha + builtAt.
const manifestVersionWithBuildTime = ((): string => {
  const now = new Date();
  const yy = now.getUTCFullYear() % 100;
  const mmdd = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes();
  return `0.${String(yy)}.${String(mmdd)}.${String(hhmm)}`;
})();

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      __BUILD_INFO__: JSON.stringify(buildInfo),
      __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    },
  }),
  manifest: {
    name: 'Sidetrack',
    version: manifestVersionWithBuildTime,
    description: 'Local-first browser AI work tracker.',
    permissions: [
      'activeTab',
      'alarms',
      'idle',
      'sidePanel',
      'storage',
      'unlimitedStorage',
      'scripting',
      'notifications',
      'tabGroups',
      'webNavigation',
      // Phase 4 — read tab URL/title across all tabs so the timeline
      // observer can see ambient browsing (HN, blog posts, search,
      // GitHub, YouTube, …). Production observation stays gated by
      // sidetrack.timeline.enabled (default OFF, opt-in only); this
      // permission only widens what's READABLE if the user enables.
      'tabs',
    ],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Allow WebAssembly compile/instantiate in extension pages so the
    // local-recall OPFS-SQLite fallback (sqlite-wasm) can load in the
    // background service worker. Without this, MV3's default CSP
    // (`script-src 'self'`) blocks WASM with:
    //   "Compiling or instantiating WebAssembly module violates the
    //    following Content Security policy directive because neither
    //    'wasm-eval' nor 'unsafe-eval' is an allowed source of script
    //    in the following Content Security Policy directive."
    // `wasm-unsafe-eval` is the MV3-approved keyword (per the Chrome
    // extension CSP allowlist) — narrower than `unsafe-eval`. The
    // WASM blob is bundled in our extension (sqlite-wasm package),
    // not pulled remotely, so the risk surface is what we already ship.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    action: {
      default_title: 'Sidetrack',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
