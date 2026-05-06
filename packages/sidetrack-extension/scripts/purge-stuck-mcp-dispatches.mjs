#!/usr/bin/env node
// Walk every .jsonl in <vault>/_BAC/dispatches and rewrite each file
// with the auto-approved MCP records removed. Backs up the original
// to <name>.bak.<timestamp> alongside the rewrite. Defaults to a
// dry run; pass --apply to actually rewrite. Pass --vault <path> if
// the vault isn't at ~/Documents/Sidetrack-vault.
//
// What it removes: any record whose mcpRequest.approval ===
// "auto-approved". These are the dispatches the MCP-auto-approval
// flow opens chat tabs for — the only ones that loop the test
// browser when stuck. User-initiated dispatches (from the side
// panel's Send-to UI) have no mcpRequest field and stay put.

import { readdir, readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const vaultIndex = args.indexOf('--vault');
const vaultArg = vaultIndex >= 0 ? args[vaultIndex + 1] : undefined;
const expandTilde = (p) =>
  p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p;
const vaultPath = expandTilde(vaultArg ?? '~/Documents/Sidetrack-vault');
const dispatchesDir = join(vaultPath, '_BAC', 'dispatches');

if (!existsSync(dispatchesDir)) {
  console.error(`No dispatches dir at ${dispatchesDir}`);
  process.exit(1);
}

const files = (await readdir(dispatchesDir)).filter((n) => n.endsWith('.jsonl')).sort();
console.log(`Vault: ${vaultPath}`);
console.log(`Mode:  ${apply ? 'APPLY (will rewrite files)' : 'dry-run (no changes)'}\n`);

let totalKept = 0;
let totalRemoved = 0;
const removedSamples = [];

for (const name of files) {
  const path = join(dispatchesDir, name);
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');
  const kept = [];
  const removed = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // Preserve malformed lines as-is — better than silently
      // dropping data the user might still want.
      kept.push(line);
      continue;
    }
    if (record?.mcpRequest?.approval === 'auto-approved') {
      removed.push(record);
    } else {
      kept.push(line);
    }
  }
  totalKept += kept.length;
  totalRemoved += removed.length;
  if (removed.length > 0) {
    console.log(`${name}: ${removed.length} auto-approved MCP record(s) flagged, ${kept.length} kept`);
    for (const r of removed.slice(0, 3)) {
      removedSamples.push({
        bac_id: r.bac_id,
        title: r.title,
        target: r.target,
        createdAt: r.createdAt,
      });
    }
    if (apply) {
      const ts = Date.now();
      await copyFile(path, `${path}.bak.${ts}`);
      const newBody = kept.length === 0 ? '' : kept.join('\n') + '\n';
      await writeFile(path, newBody, 'utf8');
      console.log(`  → rewritten; backup at ${name}.bak.${ts}`);
    }
  }
}

console.log(`\nSummary: ${totalKept} record(s) kept, ${totalRemoved} flagged for removal.`);
if (removedSamples.length > 0) {
  console.log('\nFlagged (first few):');
  for (const s of removedSamples) {
    console.log(`  - ${s.bac_id} | ${s.target?.provider}/${s.target?.mode} | ${s.createdAt} | ${(s.title ?? '').slice(0, 60)}`);
  }
}
if (!apply && totalRemoved > 0) {
  console.log('\nRe-run with --apply to actually rewrite the files. Backups (.bak.<timestamp>) are kept alongside.');
}
