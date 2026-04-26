import path from 'node:path';

import type { WriteOutcome } from '../model';
import { appendJsonLine } from './events';

export class ObservationLog {
  readonly relativePath: string;
  readonly path: string;

  constructor(vaultPath: string, runId: string) {
    this.relativePath = `_BAC/observations/run-${runId}.jsonl`;
    this.path = path.join(vaultPath, this.relativePath);
  }

  async append(outcome: WriteOutcome): Promise<void> {
    await appendJsonLine(this.path, outcome);
  }
}
