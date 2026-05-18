import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const scriptPath = join(repoRoot, 'scripts', 'graph-inventory-from-connections.mjs');
const fixturePath = join(here, '__fixtures__', 'graph-inventory-v0.json');

const section = (stdout: string, title: string): string => {
  const marker = `\n${title}\n`;
  const start = stdout.indexOf(marker);
  if (start < 0) return '';
  const rest = stdout.slice(start + marker.length);
  const next = rest.indexOf('\n\n');
  return next < 0 ? rest : rest.slice(0, next);
};

describe('graph-inventory-from-connections CLI', () => {
  it('prints V0 node, edge, provenance, endpoint, and family inventory', async () => {
    const result = await execFileAsync(process.execPath, [scriptPath, fixturePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const stdout = String(result.stdout);

    expect(stdout).toContain(`Snapshot: ${fixturePath}`);
    expect(stdout).toContain('nodes: 5');
    expect(stdout).toContain('edges: 4');
    expect(stdout).toContain('missingEndpointCount: 1');
    expect(stdout).toContain('classEInferredEdgeCount: 2');
    expect(stdout).toContain('workstreamEdgeCount: 1');
    expect(stdout).toContain('topicEdgeCount: 0');
    expect(stdout).toContain('closestVisitEdgeCount: 1');

    expect(section(stdout, 'Nodes by kind')).toContain('  timeline-visit: 1');
    expect(section(stdout, 'Nodes by kind')).toContain('  thread: 1');
    expect(section(stdout, 'Nodes by kind')).toContain('  snippet: 1');
    expect(section(stdout, 'Nodes by kind')).toContain('  workstream: 1');
    expect(section(stdout, 'Nodes by kind')).toContain('  topic: 1');

    expect(section(stdout, 'Edges by kind')).toContain('  visit_resembles_visit: 1');
    expect(section(stdout, 'Edges by kind')).toContain('  visit_in_workstream: 1');
    expect(section(stdout, 'Edges by kind')).toContain('  closest_visit: 1');
    expect(section(stdout, 'Edges by kind')).toContain('  thread_references_url: 1');

    expect(section(stdout, 'Edges by confidence')).toContain('  inferred: 2');
    expect(section(stdout, 'Edges by confidence')).toContain('  asserted: 1');
    expect(section(stdout, 'Edges by confidence')).toContain('  observed: 1');

    const producerSection = section(stdout, 'Edges by producedBy.eventType / revision producer');
    expect(producerSection).toContain('  event:capture.recorded: 1');
    expect(producerSection).toContain('  event:user.organized.item: 1');
    expect(producerSection).toContain('  revision:ranker: 1');
    expect(producerSection).toContain('  revision:visit-similarity: 1');

    expect(section(stdout, 'Edges by metadata presence')).toContain('  with metadata: 3');
    expect(section(stdout, 'Edges by metadata presence')).toContain('  without metadata: 1');

    expect(section(stdout, 'Edges by family')).toContain('  urlmatch: 3');
    expect(section(stdout, 'Edges by family')).toContain('  contain: 1');
    expect(section(stdout, 'Candidate path family counts (valid endpoints only)')).toContain(
      '  urlmatch: 2',
    );
    expect(section(stdout, 'Candidate path family counts (valid endpoints only)')).toContain(
      '  contain: 1',
    );
  });
});
