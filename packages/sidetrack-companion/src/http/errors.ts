// Typed companion HTTP errors.
//
// These replace ad-hoc `error.message === '…'` string comparisons in
// the request handler. Keeping the classes here (rather than inline in
// server.ts) lets both the throw sites and the handler import the same
// identity for `instanceof` checks.

// The legacy message string that the vault writer throws when the vault
// path can't be reached. The handler historically matched on this exact
// string to map the failure to a 503. Until every throw site migrates
// to `VaultUnavailableError`, `matches()` also recognises this literal
// so the wire response shape is byte-identical during the transition.
const LEGACY_VAULT_UNAVAILABLE_MESSAGE = 'Vault path is unavailable.';

/**
 * Thrown when the configured vault path cannot be reached (deleted,
 * unmounted external drive, permissions revoked). Maps to HTTP 503
 * VAULT_UNAVAILABLE in the request handler.
 */
export class VaultUnavailableError extends Error {
  readonly code = 'VAULT_UNAVAILABLE' as const;

  constructor(message: string = LEGACY_VAULT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'VaultUnavailableError';
  }

  /**
   * True for a genuine `VaultUnavailableError` or for the legacy
   * stringly-typed error the vault writer still throws. Callers should
   * prefer throwing `VaultUnavailableError` directly; this bridge exists
   * only so the pre-existing throw site keeps mapping to 503 without a
   * cross-module edit.
   */
  static matches(error: unknown): boolean {
    return (
      error instanceof VaultUnavailableError ||
      (error instanceof Error && error.message === LEGACY_VAULT_UNAVAILABLE_MESSAGE)
    );
  }
}
