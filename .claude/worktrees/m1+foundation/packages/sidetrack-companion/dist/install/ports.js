import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const nodeFilePort = {
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, body) => writeFile(path, body, 'utf8'),
    rm: (path) => rm(path, { force: true }),
    exists: async (path) => {
        try {
            await access(path);
            return true;
        }
        catch {
            return false;
        }
    },
};
export const nodeExecPort = {
    execFile: (file, args) => execFileAsync(file, [...args]).then(() => undefined),
};
//# sourceMappingURL=ports.js.map