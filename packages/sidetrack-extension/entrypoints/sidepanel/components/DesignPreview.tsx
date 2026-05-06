import { useState } from 'react';

import type { AnnotationMarker } from './AnnotationOverlay';
import { AnnotationOverlay } from './AnnotationOverlay';
import type { CodingOffer } from './CodingOfferBanner';
import { CodingOfferBanner } from './CodingOfferBanner';
import type { DejaVuItem } from './DejaVuPopover';
import { DejaVuPopover } from './DejaVuPopover';
import { Icons } from './icons';
import type { LinkedNote } from './LinkedNotes';
import { NeedsOrganizeSuggestion } from './NeedsOrganizeSuggestion';
import { SafetyChainSummary } from './SafetyChainSummary';
import type { TrustEntry } from './TrustToggles';
import { WorkstreamDetailPanel } from './WorkstreamDetailPanel';

// Design preview surface — shows v2 components that don't yet have
// a wired-up runtime home (DejaVu pop, annotation overlay, etc.) so
// the user can inspect them in the test browser. Each component is
// rendered against fixture data with toggles to flip states.
//
// This is dev-tooling, not user-facing — reachable via the design
// preview header icon. Mark with `data-design-preview="true"` on root
// for any future "hide in production" gate.

const FIXTURE_DEJA: readonly DejaVuItem[] = [
  {
    id: 'd1',
    providerLabel: 'Claude',
    providerKey: 'claude',
    title: 'Threat model — replay defense',
    snippet:
      '…use HMAC-SHA256 and keep tolerance under ±2 minutes for production replay defense…',
    relativeWhen: '14 days ago',
    score: 0.92,
  },
  {
    id: 'd2',
    providerLabel: 'GPT',
    providerKey: 'gpt',
    title: 'Stripe webhook tolerance review',
    snippet: '5 min is too generous; tighten to 2 min server-side.',
    relativeWhen: '32 days ago',
    score: 0.78,
  },
  {
    id: 'd3',
    providerLabel: 'Web',
    providerKey: 'web',
    title: 'stripe.com/docs/webhooks/signatures',
    snippet: 'Stripe-Signature header includes timestamp; reject if too old.',
    relativeWhen: '14 days ago',
    score: 0.71,
  },
];

const FIXTURE_ANN_MARKERS: readonly AnnotationMarker[] = [
  { id: 'm1', topPercent: 38, count: 1, tone: 'signal' },
  { id: 'm2', topPercent: 54, count: 2, tone: 'amber' },
];

const FIXTURE_OFFER: CodingOffer = {
  tabId: 1,
  surfaceLabel: 'Codex',
  cwd: '~/code/sidetrack',
  branch: 'feat/dispatch-safety',
  suggestedWorkstreamLabel: 'MVP PRD',
};

const FIXTURE_LINKED: readonly LinkedNote[] = [
  {
    id: 'n1',
    title: 'mvp-prd.md',
    relativePath: '_BAC/workstreams/sidetrack/',
    editedAt: '2026-04-26 09:14',
    pinned: true,
  },
  {
    id: 'n2',
    title: 'dispatch-safety.md',
    relativePath: '_BAC/workstreams/sidetrack/',
    editedAt: '2026-04-25 17:02',
  },
  {
    id: 'n3',
    title: 'replay-defense-meeting.md',
    relativePath: '_BAC/captures/',
    editedAt: '2026-04-22 14:31',
  },
];

const FIXTURE_TRUST: readonly TrustEntry[] = [
  {
    tool: 'sidetrack.queue.create',
    humanLabel: 'queue_item',
    description: 'queue an outbound follow-up to a provider',
    allowed: true,
  },
  {
    tool: 'sidetrack.threads.move',
    humanLabel: 'move_item',
    description: 'move a tracked thread to this workstream',
    allowed: false,
  },
  {
    tool: 'sidetrack.workstreams.bump',
    humanLabel: 'bump_workstream',
    description: 'raise priority on a queued ask',
    allowed: false,
  },
  {
    tool: 'sidetrack.threads.archive',
    humanLabel: 'archive_thread',
    description: 'archive a tracked thread',
    allowed: false,
  },
];

interface DesignPreviewProps {
  readonly onClose: () => void;
}

type Section =
  | 'deja-vu'
  | 'annotation'
  | 'coding-offer'
  | 'needs-organize'
  | 'safety-chain'
  | 'workstream-detail';

const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
  { id: 'deja-vu', label: 'Déjà-vu pop' },
  { id: 'annotation', label: 'Annotation overlay' },
  { id: 'coding-offer', label: 'Coding offer' },
  { id: 'needs-organize', label: 'Needs-organize' },
  { id: 'safety-chain', label: 'Safety chain' },
  { id: 'workstream-detail', label: 'Workstream detail' },
];

export function DesignPreview({ onClose }: DesignPreviewProps) {
  const [section, setSection] = useState<Section>('deja-vu');
  const [dejaOpen, setDejaOpen] = useState(true);
  const [trust, setTrust] = useState(FIXTURE_TRUST);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const log = (action: string): void => {
    setLastAction(action);
  };

  const sectionBody = (() => {
    if (section === 'deja-vu') {
      return (
        <div style={{ position: 'relative', minHeight: 320 }}>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-3)',
              marginBottom: 16,
            }}
          >
            Déjà-vu popover anchored to a hypothetical text selection. In production it
            mounts into the host page&apos;s document via portal.
          </p>
          {dejaOpen ? (
            <DejaVuPopover
              items={FIXTURE_DEJA}
              anchor={{ top: 200, left: 60 }}
              onJump={(item) => {
                log(`jump → ${item.title}`);
                setDejaOpen(false);
              }}
              onDismiss={() => {
                setDejaOpen(false);
              }}
              onMute={() => {
                setDejaOpen(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="settings-button"
              onClick={() => {
                setDejaOpen(true);
              }}
            >
              Re-open
            </button>
          )}
        </div>
      );
    }
    if (section === 'annotation') {
      return (
        <div style={{ position: 'relative', minHeight: 320 }}>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            Annotation overlay — margin markers + restored-on-this-page hint.
          </p>
          <div
            style={{
              position: 'relative',
              minHeight: 320,
              background: 'var(--paper-light)',
              border: '1px solid var(--rule-soft)',
              borderRadius: 6,
            }}
          >
            <AnnotationOverlay
              markers={FIXTURE_ANN_MARKERS}
              hint={{
                count: FIXTURE_ANN_MARKERS.reduce((acc, m) => acc + m.count, 0),
                onOpenPanel: () => {
                  log('open annotation panel');
                },
              }}
              onMarkerClick={(id) => {
                log(`open marker ${id}`);
              }}
            />
          </div>
        </div>
      );
    }
    if (section === 'coding-offer') {
      return (
        <div>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            Coding-session attach offer — replaces the silent modal trigger.
          </p>
          <CodingOfferBanner
            offer={FIXTURE_OFFER}
            onAccept={() => {
              log('attach coding session');
            }}
            onDismiss={() => {
              log('dismiss coding offer');
            }}
          />
        </div>
      );
    }
    if (section === 'needs-organize') {
      return (
        <div>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            Per-row workstream suggestion — renders inline below an ungrouped
            thread row.
          </p>
          <NeedsOrganizeSuggestion
            suggestedLabel="Sidetrack / MVP PRD"
            confidence={0.84}
            onAccept={() => {
              log('accept suggestion');
            }}
            onPickManual={() => {
              log('open workstream picker');
            }}
            onDismiss={() => {
              log('dismiss suggestion');
            }}
          />
        </div>
      );
    }
    if (section === 'safety-chain') {
      return (
        <div>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            Dispatch-confirm progressive disclosure — collapsible safety summary.
          </p>
          <SafetyChainSummary
            checks={[
              { key: 'redact', label: 'redaction', status: 'ok', detail: '12 spans masked' },
              {
                key: 'tokens',
                label: 'token budget',
                status: 'ok',
                detail: '4.2k / 32k',
              },
              {
                key: 'sshare',
                label: 'screen-share-safe',
                status: 'ok',
                detail: 'no display capture',
              },
              {
                key: 'inject',
                label: 'injection scrub',
                status: 'ok',
                detail: 'no suspicious patterns',
              },
            ]}
          />
          <div style={{ height: 12 }} />
          <SafetyChainSummary
            defaultOpen
            checks={[
              { key: 'redact', label: 'redaction', status: 'ok', detail: '12 spans masked' },
              {
                key: 'tokens',
                label: 'token budget',
                status: 'bad',
                detail: '38.5k / 32k — over by 6.5k',
              },
              {
                key: 'sshare',
                label: 'screen-share-safe',
                status: 'ok',
                detail: 'no display capture',
              },
              {
                key: 'inject',
                label: 'injection scrub',
                status: 'warn',
                detail: '1 ambiguous span',
              },
            ]}
          />
        </div>
      );
    }
    return (
      <WorkstreamDetailPanel
        workstreamLabel="Sidetrack / MVP PRD"
        linkedNotes={FIXTURE_LINKED}
        trustEntries={trust}
        onClose={onClose}
        onAddLink={() => {
          log('open link-note picker');
        }}
        onTrustChange={(tool, next) => {
          setTrust((prev) =>
            prev.map((entry) => (entry.tool === tool ? { ...entry, allowed: next } : entry)),
          );
        }}
      />
    );
  })();

  return (
    <div className="detail-view" role="dialog" aria-label="Design preview">
      <div className="detail-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.back}</span>
        </button>
        <span className="title">Design preview</span>
        <span className="muted">v2 surfaces · fixture data</span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          padding: '10px 14px',
          borderBottom: '1px solid var(--rule-soft)',
        }}
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={'toc-link' + (section === s.id ? ' on' : '')}
            style={
              section === s.id
                ? {
                    color: 'var(--ink)',
                    borderColor: 'var(--ink)',
                  }
                : undefined
            }
            onClick={() => {
              setSection(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'workstream-detail' ? (
        sectionBody
      ) : (
        <div style={{ padding: 14 }}>{sectionBody}</div>
      )}
      {lastAction !== null ? (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            padding: '8px 14px',
            background: 'var(--paper-deep)',
            borderTop: '1px solid var(--rule)',
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            color: 'var(--ink-3)',
          }}
        >
          last action · <code style={{ color: 'var(--ink)' }}>{lastAction}</code>
        </div>
      ) : null}
    </div>
  );
}
