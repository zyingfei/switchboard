// Build-time identity, injected by Vite's `define` (see wxt.config.ts).
// Available everywhere in the bundle as a global. The shape mirrors
// the literal we stringify at build time.
declare const __BUILD_INFO__: {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
};
