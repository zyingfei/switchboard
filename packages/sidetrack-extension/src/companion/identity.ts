// Companion connection identity check.
//
// The extension talks to whatever companion answers on the
// configured port. Nothing stops a DIFFERENT companion — a test
// instance vs the daily instance, or a stale build from another
// checkout — from owning that port. Without a check the extension
// silently serves the wrong vault's data.
//
// Approach: PIN the companion identity (vaultRoot + codePath) on
// first successful attach, per port, and compare on every poll. We
// pin the OBSERVED identity rather than comparing against the
// user-typed vault-path setting because that setting is a display
// string (tilde-relative, may differ in form from the companion's
// resolved absolute path) — unreliable to compare. The pin is the
// companion's own canonical absolute path.
//
// A vault mismatch is blocking (wrong data). A code-path change with
// the same vault is a non-blocking notice (usually an intentional
// rebuild from another checkout). The rare "first attach saw the
// wrong companion" case is recovered by the explicit re-pin action.
//
// Pure functions; storage + wiring live in the background.

export interface CompanionIdentity {
  readonly companionVersion: string;
  readonly vaultRoot?: string;
  /** Absolute path of the running `dist/cli.js` — which checkout. */
  readonly codePath?: string;
  readonly pid?: number;
  /** Operator tag from SIDETRACK_INSTANCE_LABEL, e.g. "test" / "daily". */
  readonly instanceLabel?: string;
  readonly startedAt?: string;
  readonly gitSha?: string;
}

/**
 * Parse a `/v1/version` response body. Returns null if the payload
 * isn't a recognizable identity object (companionVersion is the one
 * field every companion build has emitted).
 */
export const parseCompanionIdentity = (raw: unknown): CompanionIdentity | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d['companionVersion'] !== 'string') return null;
  return {
    companionVersion: d['companionVersion'],
    ...(typeof d['vaultRoot'] === 'string' ? { vaultRoot: d['vaultRoot'] } : {}),
    ...(typeof d['codePath'] === 'string' ? { codePath: d['codePath'] } : {}),
    ...(typeof d['pid'] === 'number' ? { pid: d['pid'] } : {}),
    ...(typeof d['instanceLabel'] === 'string' ? { instanceLabel: d['instanceLabel'] } : {}),
    ...(typeof d['startedAt'] === 'string' ? { startedAt: d['startedAt'] } : {}),
    ...(typeof d['gitSha'] === 'string' ? { gitSha: d['gitSha'] } : {}),
  };
};

export type IdentityVerdict =
  /** Nothing pinned for this port yet — caller pins `current`. */
  | { readonly kind: 'first-attach' }
  /** Same vault + same code path — all good. A pid change here is
   *  just a restart and is intentionally NOT flagged. */
  | { readonly kind: 'match' }
  /** Different vault — the companion would serve the WRONG data.
   *  Blocking: the extension must not use this connection silently. */
  | {
      readonly kind: 'vault-mismatch';
      readonly pinnedVault: string | undefined;
      readonly currentVault: string | undefined;
    }
  /** Same vault, different code path / build. Non-blocking notice. */
  | {
      readonly kind: 'code-changed';
      readonly pinnedCode: string | undefined;
      readonly currentCode: string | undefined;
    };

/**
 * Compare a freshly-fetched identity against the pinned one.
 * Vault mismatch dominates a simultaneous code change — wrong data
 * is the worse problem. pid / startedAt / instanceLabel differences
 * alone never produce a non-`match` verdict (a restart is normal).
 */
export const compareCompanionIdentity = (
  pinned: CompanionIdentity | null,
  current: CompanionIdentity,
): IdentityVerdict => {
  if (pinned === null) return { kind: 'first-attach' };
  if (pinned.vaultRoot !== current.vaultRoot) {
    return {
      kind: 'vault-mismatch',
      pinnedVault: pinned.vaultRoot,
      currentVault: current.vaultRoot,
    };
  }
  if (pinned.codePath !== current.codePath) {
    return {
      kind: 'code-changed',
      pinnedCode: pinned.codePath,
      currentCode: current.codePath,
    };
  }
  return { kind: 'match' };
};

export interface IdentityWarning {
  readonly severity: 'blocking' | 'notice';
  readonly message: string;
}

/** Human-readable warning for a non-`match`/`first-attach` verdict. */
export const identityWarningFor = (verdict: IdentityVerdict): IdentityWarning | null => {
  if (verdict.kind === 'vault-mismatch') {
    return {
      severity: 'blocking',
      message:
        `Connected to a companion serving vault "${verdict.currentVault ?? '(unknown)'}", ` +
        `but this extension was pinned to "${verdict.pinnedVault ?? '(unknown)'}". ` +
        `A different companion may be on this port — data shown would be from the wrong vault. ` +
        `Stop the stale/test companion, or use "Trust this companion" if the change was intentional.`,
    };
  }
  if (verdict.kind === 'code-changed') {
    return {
      severity: 'notice',
      message:
        `Companion build changed: now running "${verdict.currentCode ?? '(unknown)'}" ` +
        `(was "${verdict.pinnedCode ?? '(unknown)'}"). Same vault — likely an intentional rebuild.`,
    };
  }
  return null;
};

/** One-line identity summary for the Health panel (operator eyeball). */
export const describeCompanionIdentity = (identity: CompanionIdentity): string => {
  const parts: string[] = [`v${identity.companionVersion}`];
  if (identity.instanceLabel !== undefined) parts.push(`label=${identity.instanceLabel}`);
  if (identity.pid !== undefined) parts.push(`pid=${String(identity.pid)}`);
  if (identity.vaultRoot !== undefined) parts.push(`vault=${identity.vaultRoot}`);
  if (identity.codePath !== undefined) parts.push(`code=${identity.codePath}`);
  return parts.join('  ');
};
