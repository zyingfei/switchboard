// Companion pairing token: one paste that carries the loopback port AND
// the bridge key, so setup doesn't make the user separately hunt the
// port and cat the key. The companion prints this at startup and writes
// it to <vault>/_BAC/.config/pair.txt.
//
// Format: st-pair://<port>/<base64url-key>
// The key charset is base64url ([A-Za-z0-9_-], no '/'), so the last '/'
// unambiguously splits port from key.

export interface ParsedPairing {
  readonly port: number;
  readonly bridgeKey: string;
}

const PAIRING_RE = /^st-pair:\/\/(\d{1,5})\/([A-Za-z0-9_-]{32,})$/u;

// Cheap prefix check so the UI can tell "the user pasted a pairing
// string" from "the user pasted a bare bridge key" and route accordingly.
export const looksLikePairingString = (input: string): boolean =>
  input.trim().toLowerCase().startsWith('st-pair://');

// Returns the port + bridge key, or null if the input isn't a
// well-formed token. Tolerant of surrounding whitespace / a trailing
// newline so pasting the whole pair.txt line works.
export const parsePairingString = (input: string): ParsedPairing | null => {
  const match = PAIRING_RE.exec(input.trim());
  if (match === null) return null;
  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { port, bridgeKey: match[2] };
};
