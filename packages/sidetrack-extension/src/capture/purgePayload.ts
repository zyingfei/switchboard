// Payload builder for the companion's /v1/privacy/domain-tombstone route
// ("Purge captured data" on a no-capture rule).
//
// SCOPE (the correctness point): a host-scoped rule (one carrying a
// `host`, the default for new rules) must purge ONLY that exact host +
// its own subdomains — so purging meet.google.com does NOT delete the
// user's mail.google.com data. We surface the rule's `host` to the
// companion so it can host-scope the tombstone + hard-delete. A legacy
// rule with no `host` (persisted before host-scoping) sends only
// `domain`, and the companion falls back to eTLD+1-family behavior for
// back-compat. This mirrors — in the OPPOSITE, data-preserving direction
// — the blocklist migration: over-purging destroys data the user kept.

import type { NoCaptureRule } from './noCaptureRules';

export interface DomainTombstonePurgeBody {
  readonly kind: NoCaptureRule['kind'];
  readonly domain: string;
  // Present ⇒ host-scoped purge (host + own subdomains). Omitted for
  // legacy family-wide rules so the companion keeps eTLD+1 semantics.
  readonly host?: string;
  // 'similar' rules also send their category tokens for cross-domain
  // token matching at the companion's read boundary.
  readonly categoryTokens?: readonly string[];
}

// Build the request body for a rule's purge. Sends `host` when (and only
// when) the rule is host-scoped (rule.host present + non-empty); sends
// only `domain` otherwise. `categoryTokens` is included for 'similar'
// rules only.
export const buildDomainTombstonePurgeBody = (
  rule: NoCaptureRule,
): DomainTombstonePurgeBody => ({
  kind: rule.kind,
  domain: rule.domain,
  ...(typeof rule.host === 'string' && rule.host.length > 0 ? { host: rule.host } : {}),
  ...(rule.kind === 'similar' ? { categoryTokens: rule.categoryTokens } : {}),
});
