import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExecPort, FilePort } from './types.js';

const execFileAsync = promisify(execFile);

export const nodeFilePort: FilePort = {
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  writeFile: (path, body) => writeFile(path, body, 'utf8'),
  rm: (path) => rm(path, { force: true }),
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

export const nodeExecPort: ExecPort = {
  execFile: (file, args) => execFileAsync(file, [...args]).then(() => undefined),
};
