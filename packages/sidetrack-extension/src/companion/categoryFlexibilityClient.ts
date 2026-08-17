// Client for the multi-membership + suggestion + prototype-lane UI-
// visibility routes (docs/plans/2026-08-16-category-flexibility-hyde.md,
// UI-visibility phase — "get shipped features into the panel where the
// user already looks"). Follows suggestionsClient.ts's lightweight
// per-file pattern (standalone fetch, no ETag/abort machinery) rather than
// HttpCompanionClient's shared request() helper, since none of these calls
// need conditional GET caching.

import { idempotencyKey } from '../idempotencyKey';
import type { CompanionSettings, Problem } from './model';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseProblemMessage = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const problem = value as Partial<Problem>;
  return typeof problem.detail === 'string'
    ? problem.detail
    : typeof problem.title === 'string'
      ? problem.title
      : undefined;
};

// ---- membership set/remove -------------------------------------------

export const MEMBERSHIP_ROLES = ['primary', 'secondary'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export interface UrlMembershipRow {
  readonly workstreamId: string;
  readonly role: MembershipRole;
  readonly provenance: string;
  readonly acceptedAtMs: number;
  readonly sourceOpportunityId?: string;
}

const isUrlMembershipRow = (value: unknown): value is UrlMembershipRow =>
  isRecord(value) &&
  typeof value['workstreamId'] === 'string' &&
  (value['role'] === 'primary' || value['role'] === 'secondary') &&
  typeof value['provenance'] === 'string' &&
  typeof value['acceptedAtMs'] === 'number';

// ---- split / new-category suggestion candidates ------------------------

export const SUGGESTION_CANDIDATE_KINDS = ['split', 'new-category'] as const;
export type SuggestionCandidateKind = (typeof SUGGESTION_CANDIDATE_KINDS)[number];

export interface SuggestionCandidateSummary {
  readonly kind: SuggestionCandidateKind;
  readonly scopeId: string;
  readonly fingerprint: string;
  readonly memberIds: readonly string[];
  readonly memberCount: number;
  readonly suggestedName: string | null;
  readonly updatedAt: number;
}

const isSuggestionCandidateSummary = (value: unknown): value is SuggestionCandidateSummary =>
  isRecord(value) &&
  (value['kind'] === 'split' || value['kind'] === 'new-category') &&
  typeof value['scopeId'] === 'string' &&
  typeof value['fingerprint'] === 'string' &&
  Array.isArray(value['memberIds']) &&
  value['memberIds'].every((id) => typeof id === 'string') &&
  typeof value['memberCount'] === 'number' &&
  (value['suggestedName'] === null || typeof value['suggestedName'] === 'string') &&
  typeof value['updatedAt'] === 'number';

// ---- prototype-lane status ----------------------------------------------

export interface WorkstreamPrototypeStatus {
  readonly workstreamId: string;
  readonly prototypeCount: number;
  readonly generatedAt: number | null;
  readonly evidenceCount: number;
  readonly evidenceWatermark: string | null;
  readonly engine: string | null;
  readonly engineLabel: string | null;
  readonly method: 'generated' | 'selected' | null;
  readonly methodNote: string | null;
  readonly whyNot: string | null;
  readonly whyNotDetail: string | null;
}

const isWorkstreamPrototypeStatus = (value: unknown): value is WorkstreamPrototypeStatus =>
  isRecord(value) &&
  typeof value['workstreamId'] === 'string' &&
  typeof value['prototypeCount'] === 'number' &&
  (value['generatedAt'] === null || typeof value['generatedAt'] === 'number') &&
  typeof value['evidenceCount'] === 'number';

export class CategoryFlexibilityClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  private async fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-bac-bridge-key': this.settings.bridgeKey,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    return (await response.json()) as unknown;
  }

  /** Every ACTIVE membership row for one canonical URL (on-demand refresh —
   *  most card rendering instead reads the SAME data batched off
   *  `/v1/visits/projection`'s `memberships` overlay). */
  async listMemberships(canonicalUrl: string): Promise<readonly UrlMembershipRow[]> {
    const body = await this.fetchJson(`/visits/${encodeURIComponent(canonicalUrl)}/memberships`);
    const items = isRecord(body) && isRecord(body['data']) ? body['data']['memberships'] : undefined;
    return Array.isArray(items) ? items.filter(isUrlMembershipRow) : [];
  }

  /** Add (or promote) a membership row. Default role is 'secondary' — the
   *  additive "add to workstream" chip action; pass role:'primary' only
   *  for a genuine re-file. */
  async addMembership(
    canonicalUrl: string,
    workstreamId: string,
    opts: {
      readonly role?: MembershipRole;
      readonly suggestionSource?: 'workstream-split' | 'workstream-new-category';
      readonly servedOpportunityId?: string;
    } = {},
  ): Promise<void> {
    await this.fetchJson(`/visits/${encodeURIComponent(canonicalUrl)}/memberships`, {
      method: 'POST',
      headers: {
        'idempotency-key': idempotencyKey(
          'membership-set',
          `${canonicalUrl}-${workstreamId}-${String(Date.now())}`,
        ),
      },
      body: JSON.stringify({
        workstreamId,
        ...(opts.role === undefined ? {} : { role: opts.role }),
        ...(opts.suggestionSource === undefined ? {} : { suggestionSource: opts.suggestionSource }),
        ...(opts.servedOpportunityId === undefined
          ? {}
          : { servedOpportunityId: opts.servedOpportunityId }),
      }),
    });
  }

  /** Remove ONE membership row (the chip's "×" affordance). Never touches
   *  any other workstream the URL belongs to. */
  async removeMembership(
    canonicalUrl: string,
    workstreamId: string,
    reason: 'user-declined' | 'user-removed' | 'superseded' = 'user-removed',
  ): Promise<void> {
    await this.fetchJson(
      `/visits/${encodeURIComponent(canonicalUrl)}/memberships/${encodeURIComponent(workstreamId)}/remove`,
      {
        method: 'POST',
        headers: {
          'idempotency-key': idempotencyKey(
            'membership-remove',
            `${canonicalUrl}-${workstreamId}-${String(Date.now())}`,
          ),
        },
        body: JSON.stringify({ reason }),
      },
    );
  }

  /** Emitted, non-dismissed split candidates for ONE workstream — render
   *  inline in that workstream's own detail view. */
  async splitSuggestionsFor(workstreamId: string): Promise<readonly SuggestionCandidateSummary[]> {
    const body = await this.fetchJson(
      `/workstreams/suggestions?kind=split&workstreamId=${encodeURIComponent(workstreamId)}`,
    );
    const items = isRecord(body) && isRecord(body['data']) ? body['data']['candidates'] : undefined;
    return Array.isArray(items) ? items.filter(isSuggestionCandidateSummary) : [];
  }

  /** Emitted, non-dismissed new-category candidates from the UNFILED pool —
   *  render inline in the Inbox, where those pages already live. */
  async newCategorySuggestions(): Promise<readonly SuggestionCandidateSummary[]> {
    const body = await this.fetchJson('/workstreams/suggestions?kind=new-category');
    const items = isRecord(body) && isRecord(body['data']) ? body['data']['candidates'] : undefined;
    return Array.isArray(items) ? items.filter(isSuggestionCandidateSummary) : [];
  }

  /** Decline a split/new-category suggestion candidate — sticky, the exact
   *  fingerprint never resurfaces even across future recomputes. */
  async declineSuggestionCandidate(
    candidate: Pick<SuggestionCandidateSummary, 'kind' | 'fingerprint'> & { readonly scopeId?: string },
  ): Promise<void> {
    await this.fetchJson('/workstreams/suggestions/decline', {
      method: 'POST',
      headers: {
        'idempotency-key': idempotencyKey(
          'suggestion-decline',
          `${candidate.kind}-${candidate.fingerprint}`,
        ),
      },
      body: JSON.stringify({
        kind: candidate.kind,
        fingerprint: candidate.fingerprint,
        ...(candidate.kind === 'split' && candidate.scopeId !== undefined
          ? { workstreamId: candidate.scopeId }
          : {}),
      }),
    });
  }

  /** Per-workstream prototype-lane status — count, engine, why-not. Read
   *  once per panel-open / workstream-switch, not per render. */
  async prototypeStatuses(): Promise<readonly WorkstreamPrototypeStatus[]> {
    const body = await this.fetchJson('/workstreams/prototypes/status');
    const items = isRecord(body) && isRecord(body['data']) ? body['data']['statuses'] : undefined;
    return Array.isArray(items) ? items.filter(isWorkstreamPrototypeStatus) : [];
  }
}

export const createCategoryFlexibilityClient = (
  settings: CompanionSettings,
): CategoryFlexibilityClient => new CategoryFlexibilityClient(settings);
