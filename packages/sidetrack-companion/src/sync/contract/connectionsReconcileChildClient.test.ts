import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runReconcileInChild,
  setReconcileChildScriptOverride,
} from './connectionsReconcileChildClient.js';

describe('Stage 5.2 W1 — runReconcileInChild harness', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sidetrack-w1-child-'));
  });

  afterEach(async () => {
    setReconcileChildScriptOverride(undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not SIGTERM the child after a successful result message', async () => {
    const scriptPath = join(tmpDir, 'success.mjs');
    const sigtermPath = join(tmpDir, 'sigterm.txt');
    await writeFile(
      scriptPath,
      `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(sigtermPath)}, 'sigterm');
  process.exit(143);
});
process.on('message', (msg) => {
  process.send({
    seq: msg.seq,
    ok: true,
    snapshotRevision: 'rev-' + String(msg.seq),
  });
  setTimeout(() => process.exit(0), 50);
});
`,
    );
    setReconcileChildScriptOverride(scriptPath);
    const result = await runReconcileInChild({ vaultRoot: tmpDir, seq: 7 });
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(result).toEqual({ seq: 7, ok: true, snapshotRevision: 'rev-7' });
    expect(existsSync(sigtermPath)).toBe(false);
  });

  it('surfaces exit-without-message as an error result', async () => {
    const scriptPath = join(tmpDir, 'silent-exit.mjs');
    await writeFile(scriptPath, `process.exit(0);\n`);
    setReconcileChildScriptOverride(scriptPath);
    const result = await runReconcileInChild({ vaultRoot: tmpDir, seq: 1 });
    expect(result.ok).toBe(false);
    expect(result.seq).toBe(1);
    expect(result.error).toContain('without posting result');
  });
});
