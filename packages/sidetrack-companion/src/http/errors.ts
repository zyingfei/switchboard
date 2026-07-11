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
