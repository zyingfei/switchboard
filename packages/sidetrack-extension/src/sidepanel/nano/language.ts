// Content-language detection + engine routing for on-device generation.
//
// WHY THIS EXISTS — a capability mismatch we were papering over. Chrome's
// built-in Prompt / Summarizer APIs (Gemini Nano) support a FIXED, small set of
// languages: English, Japanese, Spanish, German, French. Chinese is NOT among
// them. This vault is bilingual (en + zh), and the session factory used to
// declare `['en','zh']` to BOTH engines — which for Nano is a promise the model
// cannot keep: fed Chinese it either answers in the wrong language or refuses.
//
// So language is a ROUTING input, not a formatting detail:
//   - English  → Nano when it is ready (resident, free), else the explicitly
//                loaded WebGPU model, else NOT AVAILABLE with a typed reason.
//   - Chinese  → the WebGPU model ONLY (gemma-3-1b-it is multilingual). Nano is
//     or mixed    never selected; if the local model is not loaded the caller
//                gets a typed reason it can render, and a link to the one place
//                that loads it (Health → Experiments).
//
// Everything here is PURE — no probing, no I/O, and above all NO model load.
// Routing NEVER triggers a download; it returns a reason instead. The ~800MB
// WebGPU fetch stays reachable only from the explicit Health-row button.

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The three content-language buckets that change routing. Deliberately coarse:
 * we only need to know whether Chinese text is present in enough quantity that
 * a Nano generation would be wrong.
 */
export type ContentLanguage = 'en' | 'zh' | 'mixed-en-zh';

// Sampling budget — long pages are sampled head + middle + tail so a document
// whose Chinese section sits at the end is still detected (a head-only sample
// would call a bilingual doc "English"). 4k chars is plenty of evidence.
const SAMPLE_HEAD_CHARS = 2000;
const SAMPLE_MIDDLE_CHARS = 1000;
const SAMPLE_TAIL_CHARS = 1000;
const SAMPLE_THRESHOLD_CHARS = SAMPLE_HEAD_CHARS + SAMPLE_MIDDLE_CHARS + SAMPLE_TAIL_CHARS;

/**
 * Codepoint ranges counted as Chinese evidence. Han ideographs only —
 * Hiragana/Katakana are deliberately EXCLUDED (Japanese is a language Nano
 * DOES support, so kana must not push content into the zh bucket), and CJK
 * punctuation is excluded too (a Chinese full stop inside an English page is
 * not evidence of Chinese prose).
 */
const HAN_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0x20000, 0x2a6df], // Extension B (surrogate pairs — iterated by codepoint)
];

const isHan = (codePoint: number): boolean =>
  HAN_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);

// Latin letters (the "English side" of the ratio). ASCII A–Z/a–z plus the
// Latin-1/Extended-A accented letters, so "café" counts as Latin evidence.
const isLatinLetter = (codePoint: number): boolean =>
  (codePoint >= 0x41 && codePoint <= 0x5a) ||
  (codePoint >= 0x61 && codePoint <= 0x7a) ||
  (codePoint >= 0xc0 && codePoint <= 0x24f);

/**
 * Share of Han characters among all script-bearing (Han + Latin) characters at
 * or above which the content reads as Chinese prose rather than a bilingual
 * document. 0.6 = the majority of the writing is Han.
 */
export const ZH_DOMINANT_SHARE = 0.6;
/**
 * Share at or above which Chinese is present in a load-bearing way (a whole
 * paragraph, a quoted passage) rather than incidentally — a mixed document.
 * Han is denser than Latin (one glyph ≈ one word), so 8% of the script
 * characters being Han already means a substantial Chinese passage.
 */
export const ZH_MIXED_SHARE = 0.08;
/**
 * Absolute Han-character floor for the mixed verdict. Below this a handful of
 * glyphs (a name, a brand, one emoji-adjacent term) must NOT block the Nano
 * route for an otherwise English page.
 */
export const ZH_MIXED_MIN_CHARS = 12;

/**
 * Reduce long text to a representative sample: head + middle + tail. Text at or
 * below the threshold passes through unchanged.
 */
const sampleForDetection = (text: string): string => {
  if (text.length <= SAMPLE_THRESHOLD_CHARS) return text;
  const head = text.slice(0, SAMPLE_HEAD_CHARS);
  const midStart = Math.floor(text.length / 2 - SAMPLE_MIDDLE_CHARS / 2);
  const middle = text.slice(midStart, midStart + SAMPLE_MIDDLE_CHARS);
  const tail = text.slice(text.length - SAMPLE_TAIL_CHARS);
  return `${head}${middle}${tail}`;
};

/**
 * Detect the content language by Han-vs-Latin codepoint ratio over a sampled
 * slice. No word lists, no dictionaries — Unicode ranges only, so it works on
 * any vocabulary and cannot rot.
 *
 *   - 'zh'           Han share ≥ ZH_DOMINANT_SHARE (0.6) of script characters.
 *   - 'mixed-en-zh'  Han share ≥ ZH_MIXED_SHARE (0.08) AND at least
 *                    ZH_MIXED_MIN_CHARS (12) Han characters.
 *   - 'en'           everything else, including text with no script evidence at
 *                    all (numbers/symbols) — 'en' is the safe default because a
 *                    wrong 'zh' call would needlessly block the Nano route.
 *
 * Note: a Japanese page contributes its kanji to the Han count but not its
 * kana; a kanji-dominant Japanese fragment can therefore read as 'mixed'. That
 * errs toward the multilingual WebGPU engine, which is the safe direction.
 */
export const detectContentLanguage = (text: string): ContentLanguage => {
  const sample = sampleForDetection(text);
  let han = 0;
  let latin = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isHan(cp)) han += 1;
    else if (isLatinLetter(cp)) latin += 1;
  }
  const scripted = han + latin;
  if (scripted === 0) return 'en';
  const share = han / scripted;
  if (share >= ZH_DOMINANT_SHARE) return 'zh';
  if (share >= ZH_MIXED_SHARE && han >= ZH_MIXED_MIN_CHARS) return 'mixed-en-zh';
  return 'en';
};

// ---------------------------------------------------------------------------
// Engine capability
// ---------------------------------------------------------------------------

/**
 * Languages Chrome's built-in Prompt / Summarizer APIs support. Chinese is
 * absent — that absence is the whole reason this module exists.
 */
export const NANO_SUPPORTED_LANGUAGES: readonly string[] = ['en', 'ja', 'es', 'de', 'fr'];

/**
 * Languages a Nano session DECLARES (expectedInputs/expectedOutputs). Only
 * English: it is the only bucket `detectContentLanguage` ever routes to Nano,
 * and declaring languages we never send would invite Chrome to fetch language
 * packs we have no use for. Must remain a subset of NANO_SUPPORTED_LANGUAGES.
 */
export const NANO_SESSION_LANGUAGES: readonly string[] = ['en'];

/** The WebGPU model (gemma-3-1b-it) is multilingual — it keeps en + zh. */
export const WEBGPU_SESSION_LANGUAGES: readonly string[] = ['en', 'zh'];

/**
 * Languages Apple's on-device model ADVERTISES, verbatim from the local
 * service's own model notes (ja, pt, zh, vi, tr, nb, es, en, fr, sv, nl, da,
 * ko, it, de).
 *
 * DO NOT ROUTE ON THIS LIST. It is recorded here precisely because it is
 * WRONG in the way that matters: the advertised list includes zh, and the
 * runtime rejects Chinese anyway. Measured 2026-07-28, macOS 26.5.2:
 *
 *   prompt written in Chinese  → HTTP 400
 *                                "Unsupported language: An unsupported
 *                                 language or locale was used"
 *   English prompt, Chinese source → answers in ENGLISH
 *
 * The second case is the dangerous one: no error, just a summary in the wrong
 * language, which validateGeneration then rejects — so a Chinese page would
 * cost a full generation and produce nothing. Routing has to know this BEFORE
 * spending the call.
 */
export const APPLE_ADVERTISED_LANGUAGES: readonly string[] = [
  'ja', 'pt', 'zh', 'vi', 'tr', 'nb', 'es', 'en', 'fr', 'sv', 'nl', 'da', 'ko', 'it', 'de',
];

/**
 * Whether Apple's on-device model can serve this content language.
 *
 * English only, from the measurement above rather than from the advertised
 * list. This is the same shape as `nanoCanServe` for the same reason, and it
 * is why the WebGPU lane is NOT superseded by Apple FM: Chinese content still
 * has exactly one engine that can handle it.
 */
export const appleCanServe = (language: ContentLanguage): boolean => language === 'en';

/** Whether Nano can serve this content language at all. */
export const nanoCanServe = (language: ContentLanguage): boolean => language === 'en';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * A passive snapshot of what is ready RIGHT NOW. Every field is observed, never
 * requested: reading this must not start a probe or a download.
 */
export interface EngineAvailability {
  /** Built-in Prompt API reports 'available' (model component resident). */
  readonly nanoReady: boolean;
  /**
   * A local Apple Foundation Models service answered its probe. On-device, so
   * it ranks with the local engines and not with `remoteReady`. Absent/false
   * when the service is not installed or not running — which is the normal
   * case, and never an error.
   */
  readonly appleReady?: boolean;
  /** The WebGPU engine was EXPLICITLY loaded this session (Health button). */
  readonly webGpuLoaded: boolean;
  /** An explicit WebGPU load is in flight right now. */
  readonly webGpuLoading?: boolean;
  /** Best-effort download percent while loading; null when unknown. */
  readonly webGpuPercent?: number | null;
  /** This browser exposes a WebGPU adapter (navigator.gpu) — i.e. the local
   *  model COULD be loaded from Health. */
  readonly webGpuSupported: boolean;
  /**
   * The OPTIONAL remote engine is explicitly enabled AND has a key. Default
   * false/absent. This is the only field whose truth means content can leave
   * the device, so it is never inferred — it comes from remoteConfigReady().
   */
  readonly remoteReady?: boolean;
  /** Host the remote engine would send to, for the privacy marker. */
  readonly remoteHost?: string | null;
}

/** Why no engine can serve this content — typed so the UI renders one honest
 *  sentence per case instead of a dead, unexplained control. */
export type EnrichmentBlockReason =
  | 'model-loading'
  | 'model-not-loaded'
  | 'language-needs-local-model'
  | 'no-engine';

export type EnrichmentRoute =
  | { readonly engine: 'nano' }
  | { readonly engine: 'apple' }
  | { readonly engine: 'webgpu' }
  | { readonly engine: 'remote' }
  | { readonly engine: null; readonly reason: EnrichmentBlockReason };

/**
 * Decide which engine may generate for this content, with NO side effects and
 * NO load. Nano is preferred for English (already resident, no download); it is
 * NEVER selected for 'zh' or 'mixed-en-zh' because the built-in API does not
 * support Chinese. Apple's on-device model sits directly behind it, under the
 * same language rule and for the same reason (measured — see appleCanServe).
 *
 * PRECEDENCE IS LOCAL-FIRST, ALWAYS: nano → apple → local WebGPU model →
 * remote. The ordering within the on-device group is by SETUP COST, not by
 * measured quality: Nano needs nothing running, Apple needs a local service,
 * WebGPU needs an 820MB download. Apple outranks WebGPU on evidence as well —
 * measured 2026-07-28 on identical documents, prompts and scoring, Apple FM ran
 * 4.1s median at 0.61 groundedness against WebGPU's 17.3s at 0.47 — but the
 * ordering would hold on setup cost alone, and stating it that way keeps the
 * rule stable when the numbers move.
 *
 * The remote engine is last not because it is worst but because it is the only
 * one that sends page text off the device; it is reached only when no on-device
 * engine can serve, and only when the user explicitly enabled it with a key
 * (`remoteReady`, which is remoteConfigReady()). It DOES outrank the "wait for
 * the local download" block reasons — a user who turned it on asked for an
 * answer now, and the surface marks every remote run in their face.
 *
 * The full table (language × availability):
 *
 *   en    · nano ready                        → nano
 *   en    · apple service up                  → apple
 *   en    · webgpu loaded                     → webgpu
 *   en    · remote enabled + key              → remote
 *   en    · webgpu loading                    → none: model-loading
 *   en    · webgpu supported, not loaded      → none: model-not-loaded
 *   en    · no nano, no webgpu adapter        → none: no-engine
 *   zh/mx · webgpu loaded                     → webgpu   (even if nano/apple up)
 *   zh/mx · remote enabled + key              → remote   (multilingual provider)
 *   zh/mx · webgpu loading                    → none: model-loading
 *   zh/mx · nano or apple ready, webgpu loadable
 *                                             → none: language-needs-local-model
 *   zh/mx · nothing on-device, webgpu loadable→ none: model-not-loaded
 *   zh/mx · no webgpu adapter                 → none: no-engine
 */
export const routeEnrichmentEngine = (
  language: ContentLanguage,
  availability: EngineAvailability,
): EnrichmentRoute => {
  const nanoUsable = availability.nanoReady && nanoCanServe(language);
  if (nanoUsable) return { engine: 'nano' };
  const appleUsable = availability.appleReady === true && appleCanServe(language);
  if (appleUsable) return { engine: 'apple' };
  if (availability.webGpuLoaded) return { engine: 'webgpu' };
  if (availability.remoteReady === true) return { engine: 'remote' };
  if (availability.webGpuLoading === true) return { engine: null, reason: 'model-loading' };
  if (!availability.webGpuSupported) return { engine: null, reason: 'no-engine' };
  // The local model is loadable from Health. Distinguish "you never loaded it"
  // from "you loaded nothing AND the on-device models can't help here because
  // of the language" — the second needs the language named or the user
  // reasonably asks why a 'ready' engine isn't being used. Apple joins Nano in
  // that second case: both are up, both refuse Chinese, and saying so is the
  // difference between a helpful sentence and a dead control.
  const onDeviceRefusedLanguage =
    (availability.nanoReady && !nanoCanServe(language)) ||
    (availability.appleReady === true && !appleCanServe(language));
  if (onDeviceRefusedLanguage) {
    return { engine: null, reason: 'language-needs-local-model' };
  }
  return { engine: null, reason: 'model-not-loaded' };
};
