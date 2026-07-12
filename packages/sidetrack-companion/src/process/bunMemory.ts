import { basename } from 'node:path';

interface BunRuntimeGlobal {
  readonly gc?: (force?: boolean) => void;
}

const SMOL_FLAG = '--smol';

const isBunExecutableToken = (token: string): boolean => {
  const base = basename(token);
  return base === 'bun' || base === 'bun.exe' || /^bun@\d/.test(base);
};

const smolAlreadyPresent = (args: readonly string[]): boolean => args.includes(SMOL_FLAG);

export const withBunSmolCommand = (command: readonly string[]): readonly string[] => {
  if (smolAlreadyPresent(command)) return command;
  const bunIndex = command.findIndex(isBunExecutableToken);
  if (bunIndex < 0) return command;
  return [...command.slice(0, bunIndex + 1), SMOL_FLAG, ...command.slice(bunIndex + 1)];
};

export const withBunSmolExecArgv = (execArgv: readonly string[]): string[] => {
  const bunVersion = (process.versions as NodeJS.ProcessVersions & { readonly bun?: string }).bun;
  if (bunVersion === undefined || smolAlreadyPresent(execArgv)) return [...execArgv];
  return [SMOL_FLAG, ...execArgv];
};

// DISABLED: Bun.gc(true) does NOT return memory to the OS on macOS — it
// faults the entire swapped/compressed heap back into RAM to walk it,
// spiking the main process's RSS (measured 39MB idle -> 1.2GB per drain)
// while the footprint (allocator high-water) is unchanged. Net-harmful.
// Kept as a no-op so the post-drain call sites stay but do nothing.
export const requestBunMemoryRelease = (): boolean => false;
