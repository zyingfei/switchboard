// Fast char/4 token heuristic, matching what PacketComposer renders for
// live preview. Real cl100k counts come from the companion at dispatch
// time; we don't bundle the BPE table into the side-panel/content bundle
// to keep MV3 size in check.
//
// Lives in its own module so both the outbound-dispatch preflight
// (dispatch/outboundPreflight.ts) and the auto-send preflight
// (safety/preflight.ts) can share it without an import cycle.
export const estimateTokensFast = (text: string): number => Math.ceil(text.length / 4);
