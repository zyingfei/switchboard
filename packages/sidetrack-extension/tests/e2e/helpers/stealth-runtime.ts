import type { BrowserContext, chromium as baseChromium } from '@playwright/test';

type PersistentContextOptions = NonNullable<
  Parameters<typeof baseChromium.launchPersistentContext>[1]
>;

interface PatchrightChromium {
  readonly launchPersistentContext: (
    userDataDir: string,
    options: PersistentContextOptions,
  ) => Promise<BrowserContext>;
}

interface PatchrightModule {
  readonly chromium: PatchrightChromium;
}

export interface StealthLaunchInput {
  readonly userDataDir: string;
  readonly options: PersistentContextOptions;
}

export interface StealthLaunchResult {
  readonly context: BrowserContext;
  readonly patchrightLoaded: boolean;
}

const loadPatchright = async (): Promise<{
  readonly chromium: PatchrightChromium;
  readonly patchrightLoaded: boolean;
}> => {
  const patchright = (await import('patchright')) as PatchrightModule;
  return { chromium: patchright.chromium, patchrightLoaded: true };
};

export const launchStealthPersistentContext = async (
  input: StealthLaunchInput,
): Promise<StealthLaunchResult> => {
  const { chromium, patchrightLoaded } = await loadPatchright();
  const context = await chromium.launchPersistentContext(input.userDataDir, input.options);
  return { context, patchrightLoaded };
};
