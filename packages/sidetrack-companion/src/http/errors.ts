// Typed companion HTTP errors.
//
// These replace ad-hoc `error.message === '…'` string comparisons in
// the request handler. Keeping the classes here (rather than inline in
// server.ts) lets both the throw sites and the handler import the same
// identity for `instanceof` checks.

// The message the vault writer surfaces when the vault path can't be
// reached. It stays the default constructor message so the wire
// response `detail` is byte-identical to the pre-typed-error behaviour
// (the writer used to `throw new Error('Vault path is unavailable.')`).
const VAULT_UNAVAILABLE_MESSAGE = 'Vault path is unavailable.';

/**
 * Thrown when the configured vault path cannot be reached (deleted,
 * unmounted external drive, permissions revoked). Maps to HTTP 503
 * VAULT_UNAVAILABLE in the request handler.
 */
export class VaultUnavailableError extends Error {
  readonly code = 'VAULT_UNAVAILABLE' as const;

  constructor(message: string = VAULT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'VaultUnavailableError';
  }

  /**
   * True for a `VaultUnavailableError`. The vault writer now throws this
   * type directly (no more stringly-typed error), so an `instanceof`
   * check is sufficient — the legacy-message bridge has been retired.
   */
  static matches(error: unknown): boolean {
    return error instanceof VaultUnavailableError;
  }
}

/**
 * Thrown when a user-facing export (workstream / thread report) would
 * resolve to a path OUTSIDE the vault root, or INSIDE the machine-
 * managed `_BAC/` tree. The export tree is derived from user-controlled
 * titles (`z.string().min(1)`, otherwise unrestricted), so a title like
 * `.. ..` or `_BAC` could otherwise steer the write past the vault
 * boundary or clobber the canonical record store.
 *
 * This is a client-input rejection, not a server fault, so it maps to
 * HTTP 400 `EXPORT_PATH_REJECTED`. The `status` field is carried on the
 * instance so the request handler can map it without a bespoke
 * `instanceof` branch.
 *
 * Defence-in-depth: `sanitizePathSegment` already neuters `.`, `..`,
 * empty, and `_BAC` segments, so this guard should never fire for
 * schema-valid input — it exists to fail closed if the sanitizer is
 * ever weakened.
 */
export class VaultExportConfinementError extends Error {
  readonly code = 'EXPORT_PATH_REJECTED' as const;
  readonly status = 400 as const;

  constructor(message = 'Export path escapes the vault boundary.') {
    super(message);
    this.name = 'VaultExportConfinementError';
  }

  static matches(error: unknown): boolean {
    return error instanceof VaultExportConfinementError;
  }
}
