#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const scanRoots = [
  "packages/sidetrack-companion/src/connections",
  "packages/sidetrack-companion/src/producers",
];
const ignoredSegments = new Set(["__fixtures__"]);
const ignoredSuffixes = [".test.ts", ".test.tsx", ".d.ts"];
const banned = [
  "Hacker News",
  "Oracle",
  "OCI",
  "Cactus",
  "Switchboard",
  "TokenWeave",
  "google.com",
  "news.ycombinator",
];

const files = [];

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredSegments.has(entry.name)) continue;
      await walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (ignoredSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
    files.push(fullPath);
  }
};

for (const root of scanRoots) {
  await walk(join(repoRoot, root));
}

const findings = [];
for (const file of files) {
  const body = await readFile(file, "utf8");
  for (const needle of banned) {
    const index = body.indexOf(needle);
    if (index < 0) continue;
    const line = body.slice(0, index).split("\n").length;
    findings.push(
      `${file.replace(`${repoRoot}/`, "")}:${String(line)} contains ${JSON.stringify(needle)}`,
    );
  }
}

if (findings.length > 0) {
  console.error(
    "Focus clustering code must not contain host-specific or topic-name rules.",
  );
  for (const finding of findings) console.error(finding);
  process.exit(1);
}
