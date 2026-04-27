import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const output = join(root, '.output', 'chrome-mv3');
const manifestPath = join(output, 'manifest.json');

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const requiredPermissions = new Set(['activeTab', 'sidePanel', 'storage']);
  const actualPermissions = new Set(manifest.permissions ?? []);
  for (const permission of requiredPermissions) {
    if (!actualPermissions.has(permission)) {
      fail(`Missing manifest permission: ${permission}`);
    }
  }

  if (manifest.side_panel?.default_path !== 'sidepanel.html') {
    fail('Manifest side panel default_path is not sidepanel.html');
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    fail('Manifest has no content script registrations.');
  }

  await access(join(output, 'background.js'));
  await access(join(output, 'sidepanel.html'));
  await access(join(output, 'content-scripts', 'content.js'));
} catch (error) {
  fail(error instanceof Error ? error.message : 'Extension build verification failed.');
}
