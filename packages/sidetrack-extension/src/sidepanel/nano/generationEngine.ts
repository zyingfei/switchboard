// The GenerationEngine seam itself, split out of engine.ts so the adapters can
// depend on the interface without depending on the module that WIRES the
// adapters together (engine.ts imports every adapter; an adapter importing
// engine.ts back would be a cycle).
//
// engine.ts re-exports everything here, so `import { GenerationEngine } from
// './engine'` keeps working at every existing call site.

import { resolveGenerationOptions, type GenerationOptions } from './generationOptions';
import type { EngineIdentity, EngineKind } from './modelRegistry';
import type { EngineLimits } from './engineLimits';

export interface GenerationEngine {
  readonly kind: EngineKind;
  /**
   * WHICH model this is — parameters and quantization, declared. Optional so a
   * test stub stays a two-field object; read it through `engineIdentityOf`,
   * which fills in the kind's default.
   */
  readonly identity?: EngineIdentity;
  /** Input/output caps for this engine. Optional for the same reason. */
  readonly limits?: EngineLimits;
  /**
   * Generate from `prompt`. Every decoding field except `maxNewTokens` is
   * optional and defaults to the anti-degeneracy values in
   * generationOptions.ts — an unsafe decoder must not be reachable by
   * forgetting a field at a call site.
   *
   * `signal` is honored by engines that can be interrupted (the remote adapter
   * passes it to fetch). On-device engines ignore it: neither the Prompt API nor
   * a transformers.js pipeline exposes cancellation.
   */
  generate: (prompt: string, opts: GenerationOptions, signal?: AbortSignal) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Output cleanup — the PoC showed the WebGPU model wraps titles in markdown
// ("**title**") and sometimes in quotes; Nano stays cleaner but the same
// cleanup is harmless there. Strip surrounding asterisks/quotes, collapse
// stray inner ** emphasis, trim, and cap. Pure + unit-tested.
//
// The cap is a PARAMETER, not a constant: this cleanup runs on gists too, and
// capping a gist at the 200-char title limit was silently truncating every
// multi-sentence summary mid-word before it was ever saved.
// ---------------------------------------------------------------------------

export const MAX_GENERATED_CHARS = 200;

export const cleanGeneratedText = (raw: string, maxChars: number): string => {
  let text = raw.trim();
  // Strip a leading/trailing run of markdown emphasis / quote chars, then any
  // inner ** emphasis markers the model sprinkles mid-line.
  text = text.replace(/^[*_"'“”‘’\s]+/u, '').replace(/[*_"'“”‘’\s]+$/u, '');
  text = text.replace(/\*\*/gu, '').replace(/__/gu, '');
  text = text.trim();
  return text.slice(0, maxChars);
};

/** Title-shaped cleanup: the same pass capped at the title contract's 200. */
export const cleanGeneratedTitle = (raw: string): string =>
  cleanGeneratedText(raw, MAX_GENERATED_CHARS);

/** The cleaned-output cap for one generation, resolved from the options. */
export const outputCharCapOf = (opts: GenerationOptions): number =>
  resolveGenerationOptions(opts).maxChars;
