#!/usr/bin/env node
// Sidetrack-companion macOS-first package builder.
//
// Produces a versioned self-contained app directory under
// dist-packages/sidetrack-darwin-<arch>-<version>/. Layout:
//
//   bin/sidetrack-companion        wrapper script (calls system Node)
//   bin/sidetrack-mcp              wrapper script
//   companion/dist/, companion/package.json, companion/node_modules/
//   mcp/dist/, mcp/package.json, mcp/node_modules/
//   models/                        optional, when --include-model
//   install.sh                     copies the bundle under
//                                  ~/Library/Application Support/
//                                  Sidetrack/companion/<version>/
//                                  and registers the launchd plist
//   uninstall.sh
//   README.md
//
// Deliberately NOT a single-file binary: ONNX native bindings + HF
// model artifacts ship safer as a normal directory tree. Code-
// signing and notarization land in a separate pass.
//
// Usage:
//   node scripts/package-darwin.mjs
//   node scripts/package-darwin.mjs --include-model
//   node scripts/package-darwin.mjs --out dist-packages

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const companionRoot = resolve(dirname(here), '..');
const repoRoot = resolve(companionRoot, '..', '..');

const flag = (name) => process.argv.includes(name);
const flagValue = (name) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
};

const includeModel = flag('--include-model');
const outDirArg = flagValue('--out') ?? join(companionRoot, 'dist-packages');

const log = (msg) => {
  process.stdout.write(`[package-darwin] ${msg}\n`);
};

const run = (cmd, opts = {}) => {
  log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

const main = async () => {
  if (process.platform !== 'darwin') {
    log(`WARNING: running on non-darwin platform (${process.platform}). Output is still macOS-shaped.`);
  }

  // 1. Read versions.
  const companionPkg = JSON.parse(
    await readFile(join(companionRoot, 'package.json'), 'utf8'),
  );
  const mcpRoot = resolve(repoRoot, 'packages', 'sidetrack-mcp');
  let mcpPkg = null;
  if (existsSync(join(mcpRoot, 'package.json'))) {
    mcpPkg = JSON.parse(await readFile(join(mcpRoot, 'package.json'), 'utf8'));
  }
  const version = companionPkg.version || '0.0.0';
  const arch = process.arch;
  const tag = `sidetrack-darwin-${arch}-${version}`;
  const stage = resolve(outDirArg, tag);
  log(`staging ${stage}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  // 2. Build companion (and mcp if present).
  log('building companion …');
  run('npx tsc -p tsconfig.build.json', { cwd: companionRoot });
  if (mcpPkg !== null) {
    log('building mcp …');
    run('npx tsc -p tsconfig.build.json', { cwd: mcpRoot });
  }

  // 3. Stage companion files.
  await mkdir(join(stage, 'companion'), { recursive: true });
  await cp(join(companionRoot, 'dist'), join(stage, 'companion', 'dist'), { recursive: true });
  await cp(
    join(companionRoot, 'package.json'),
    join(stage, 'companion', 'package.json'),
  );
  // Use the companion's installed node_modules — it carries the ONNX
  // native bindings + transformers.js. We copy rather than reinstall
  // to keep the package builder offline-friendly.
  if (existsSync(join(companionRoot, 'node_modules'))) {
    await cp(
      join(companionRoot, 'node_modules'),
      join(stage, 'companion', 'node_modules'),
      { recursive: true, dereference: true },
    );
  } else {
    log('WARN: companion/node_modules missing — run `npm install` first.');
  }

  // 4. Stage mcp files when present.
  if (mcpPkg !== null) {
    await mkdir(join(stage, 'mcp'), { recursive: true });
    await cp(join(mcpRoot, 'dist'), join(stage, 'mcp', 'dist'), { recursive: true });
    await cp(join(mcpRoot, 'package.json'), join(stage, 'mcp', 'package.json'));
    if (existsSync(join(mcpRoot, 'node_modules'))) {
      await cp(
        join(mcpRoot, 'node_modules'),
        join(stage, 'mcp', 'node_modules'),
        { recursive: true, dereference: true },
      );
    }
  }

  // 5. Bin wrappers — call the dist entrypoints with system Node.
  await mkdir(join(stage, 'bin'), { recursive: true });
  const companionWrapper = `#!/usr/bin/env bash
set -euo pipefail
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
exec node "$DIR/../companion/dist/cli.js" "$@"
`;
  await writeFile(join(stage, 'bin', 'sidetrack-companion'), companionWrapper, 'utf8');
  await chmod(join(stage, 'bin', 'sidetrack-companion'), 0o755);
  if (mcpPkg !== null) {
    const mcpWrapper = `#!/usr/bin/env bash
set -euo pipefail
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
exec node "$DIR/../mcp/dist/cli.js" "$@"
`;
    await writeFile(join(stage, 'bin', 'sidetrack-mcp'), mcpWrapper, 'utf8');
    await chmod(join(stage, 'bin', 'sidetrack-mcp'), 0o755);
  }

  // 6. install.sh — drop the package under ~/Library/Application
  //    Support/Sidetrack/companion/<version>/ and run the existing
  //    launchd installer (companion's --install-service code path)
  //    against the deployed binary.
  const installSh = `#!/usr/bin/env bash
set -euo pipefail
HERE="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
DEST="$HOME/Library/Application Support/Sidetrack/companion/${version}"
mkdir -p "$(dirname "$DEST")"
echo "[sidetrack] installing to $DEST"
rsync -a --delete "$HERE/" "$DEST/"
ln -sf "$DEST/bin/sidetrack-companion" /usr/local/bin/sidetrack-companion 2>/dev/null || \\
  echo "(skip /usr/local/bin symlink — needs sudo)"
echo "[sidetrack] To register the launchd service:"
echo "  $DEST/bin/sidetrack-companion --install-service --vault \\"\$HOME/Documents/Sidetrack-vault\\""
`;
  await writeFile(join(stage, 'install.sh'), installSh, 'utf8');
  await chmod(join(stage, 'install.sh'), 0o755);

  const uninstallSh = `#!/usr/bin/env bash
set -euo pipefail
DEST="$HOME/Library/Application Support/Sidetrack/companion/${version}"
echo "[sidetrack] uninstalling launchd service if present"
"$DEST/bin/sidetrack-companion" --uninstall-service 2>/dev/null || true
rm -rf "$DEST"
rm -f /usr/local/bin/sidetrack-companion 2>/dev/null || true
echo "[sidetrack] removed $DEST"
`;
  await writeFile(join(stage, 'uninstall.sh'), uninstallSh, 'utf8');
  await chmod(join(stage, 'uninstall.sh'), 0o755);

  // 7. README — explain layout + first-launch.
  const readme = `# Sidetrack — macOS package (${tag})

Self-contained companion + MCP server for Sidetrack ${version}.

## Install

\`\`\`bash
./install.sh
~/Library/Application\\ Support/Sidetrack/companion/${version}/bin/sidetrack-companion --install-service \\
  --vault ~/Documents/Sidetrack-vault
\`\`\`

## Uninstall

\`\`\`bash
./uninstall.sh
\`\`\`

## Layout

- \`bin/sidetrack-companion\` — wrapper that runs \`companion/dist/cli.js\` with system Node.
- \`bin/sidetrack-mcp\` — sibling MCP server (optional).
- \`companion/\` — companion dist + node_modules (includes the ONNX native bindings).
- \`mcp/\` — MCP dist + node_modules.
- \`models/\` — embedding-model cache (only present when built with --include-model).

## Notes

- This package is unsigned. macOS will prompt on first launch; right-click → Open from Finder, or run \`xattr -dr com.apple.quarantine\` on the install dir.
- Code-signing + notarization land in a follow-up.
`;
  await writeFile(join(stage, 'README.md'), readme, 'utf8');

  // 8. Optional model prewarm.
  if (includeModel) {
    log('prewarming model cache (this may take a few minutes)…');
    await mkdir(join(stage, 'models'), { recursive: true });
    run(
      `node "${join(stage, 'companion', 'dist', 'cli.js')}" models ensure --models-dir "${join(stage, 'models')}"`,
      { cwd: stage, env: { ...process.env, SIDETRACK_MODELS_DIR: join(stage, 'models') } },
    );
  }

  // 9. Report.
  const sizeMB = (() => {
    try {
      const out = execSync(`du -sk "${stage}"`).toString();
      const kb = Number.parseInt(out.split(/\s+/)[0] ?? '0', 10);
      return Math.round(kb / 1024);
    } catch {
      return 0;
    }
  })();
  log(`✓ packaged ${tag} (${sizeMB} MB) → ${stage}`);
};

main().catch((err) => {
  process.stderr.write(`[package-darwin] FAILED: ${err?.stack ?? err}\n`);
  process.exit(1);
});
