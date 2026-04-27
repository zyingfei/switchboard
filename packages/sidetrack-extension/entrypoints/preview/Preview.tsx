import { useState } from 'react';
import {
  Annotation,
  CodingAttach,
  DispatchConfirm,
  InboundCard,
  type InboundReminder,
  MoveToPicker,
  PacketComposer,
  RecentDispatches,
  type DispatchEvent,
  ReviewComposer,
  SystemBannersStack,
  TabRecovery,
  Wizard,
} from '../sidepanel/components';

type Surface =
  | 'none'
  | 'packet'
  | 'dispatch'
  | 'review'
  | 'wizard'
  | 'coding'
  | 'annotation'
  | 'recovery'
  | 'moveTo';

const STUB_INBOUND: InboundReminder[] = [
  {
    bac_id: 'inbound-1',
    threadTitle: 'Side-panel state machine review',
    provider: 'claude',
    providerLabel: 'Claude',
    inboundTurnAt: '3 min ago',
    status: 'unseen',
    aiAuthored: true,
  },
  {
    bac_id: 'inbound-2',
    threadTitle: 'PRD §24.10 wording',
    provider: 'chatgpt',
    providerLabel: 'ChatGPT',
    inboundTurnAt: '1 hr ago',
    status: 'seen',
    aiAuthored: true,
  },
];

const STUB_DISPATCHES: DispatchEvent[] = [
  {
    bac_id: 'dispatch-1',
    sourceTitle: 'Side-panel state machine review',
    targetProviderLabel: 'GPT Pro',
    targetThreadTitle: 'new chat',
    dispatchKind: 'research_packet',
    dispatchedAt: '12 min ago',
    status: 'replied',
  },
  {
    bac_id: 'dispatch-2',
    sourceTitle: 'PRD §24.10 wording',
    targetProviderLabel: 'Claude',
    targetThreadTitle: 'compare with §27.6',
    dispatchKind: 'submit_back',
    dispatchedAt: '3 hr ago',
    status: 'sent',
  },
];

const STUB_WORKSTREAMS = [
  { bac_id: 'ws-root', path: 'Inbox' },
  { bac_id: 'ws-misc', path: 'Misc' },
  { bac_id: 'ws-sb', path: 'Sidetrack' },
  { bac_id: 'ws-sb-prd', path: 'Sidetrack / MVP PRD' },
  { bac_id: 'ws-sb-prd-active', path: 'Sidetrack / MVP PRD / Active Work' },
  { bac_id: 'ws-vm', path: 'VM Live Migration' },
];

export function Preview() {
  const [surface, setSurface] = useState<Surface>('none');

  const close = () => {
    setSurface('none');
  };
  const noop = () => {
    // intentional no-op; preview stub handlers are wired by Codex / runtime later
  };

  return (
    <div className="preview-shell">
      <PreviewToolbar onPick={setSurface} active={surface} />
      <div className="preview-canvas">
        <PreviewSection title="System banners (Mock 10)">
          <SystemBannersStack companionStatus="down" queuedCount={12} onRetryCompanion={noop} />
          <SystemBannersStack vaultStatus="unreachable" onRePickVault={noop} />
          <SystemBannersStack
            providerHealth="degraded"
            providerHealthDetail="ChatGPT extractor health: 4/10 recent captures clean — clipboard fallback active"
            onQueueDiagnostic={noop}
          />
          <SystemBannersStack screenShareActive />
          <SystemBannersStack injectionDetected />
        </PreviewSection>

        <PreviewSection title="Inbound reminders (Mock 13a)">
          {STUB_INBOUND.map((reminder) => (
            <InboundCard
              key={reminder.bac_id}
              reminder={reminder}
              onOpen={noop}
              onMarkRelevant={noop}
              onDismiss={noop}
            />
          ))}
        </PreviewSection>

        <PreviewSection title="Recent dispatches (Mock 13b)">
          <RecentDispatches dispatches={STUB_DISPATCHES} />
        </PreviewSection>
      </div>

      {surface === 'packet' ? (
        <PacketComposer
          onCancel={close}
          onCopy={close}
          onSave={close}
          onDispatch={() => {
            setSurface('dispatch');
          }}
        />
      ) : null}
      {surface === 'dispatch' ? (
        <DispatchConfirm
          target="Claude"
          screenShareActive={false}
          injectionDetected={false}
          onCancel={close}
          onEdit={() => {
            setSurface('packet');
          }}
          onConfirm={close}
        />
      ) : null}
      {surface === 'review' ? (
        <div className="modal-backdrop" onClick={close}>
          <div
            onClick={(e) => {
              e.stopPropagation();
            }}
            style={{ width: 560 }}
          >
            <ReviewComposer
              provider="Claude"
              capturedAt="2026-04-26 14:32"
              spans={[
                {
                  id: 's1',
                  text: 'Webhooks should verify the tolerance window server-side; ours is currently 5min which is too generous.',
                },
              ]}
              onClose={close}
              onSave={close}
              onSubmitBack={close}
              onDispatchOut={() => {
                setSurface('dispatch');
              }}
            />
          </div>
        </div>
      ) : null}
      {surface === 'wizard' ? <Wizard onClose={close} onFinish={close} /> : null}
      {surface === 'coding' ? (
        <CodingAttach workstreams={STUB_WORKSTREAMS} onCancel={close} onAttach={close} />
      ) : null}
      {surface === 'annotation' ? (
        <Annotation
          selection="Use HMAC with SHA-256 and reject any timestamp outside ±2 minutes."
          url="https://stripe.com/docs/webhooks/signatures"
          pageTitle="Verify webhook signatures · Stripe"
          workstreams={STUB_WORKSTREAMS}
          onCancel={close}
          onSave={close}
        />
      ) : null}
      {surface === 'recovery' ? (
        <TabRecovery
          snapshot={{
            title: 'Side-panel state machine review',
            url: 'https://claude.ai/chat/abc-123',
            provider: 'Claude',
            capturedAt: '2026-04-26 14:32',
            lastActiveAt: '2 hr ago',
            restoreStrategy: 'reopen_url',
          }}
          onClose={close}
          onReopenUrl={close}
        />
      ) : null}
      {surface === 'moveTo' ? (
        <MoveToPicker
          itemTitle="Side-panel state machine review"
          currentPath="Inbox"
          workstreams={STUB_WORKSTREAMS}
          onClose={close}
          onMove={close}
        />
      ) : null}
    </div>
  );
}

function PreviewToolbar({
  onPick,
  active,
}: {
  readonly onPick: (s: Surface) => void;
  readonly active: Surface;
}) {
  const surfaces: { key: Surface; label: string }[] = [
    { key: 'packet', label: 'Mock 5 Packet composer' },
    { key: 'dispatch', label: 'Mock 6 Dispatch confirm + safety' },
    { key: 'review', label: 'Mock 7 Inline review' },
    { key: 'wizard', label: 'Mock 8 First-run wizard' },
    { key: 'coding', label: 'Mock 12 Coding session' },
    { key: 'annotation', label: 'Mock 14 Annotation' },
    { key: 'recovery', label: 'Mock 3 Tab recovery' },
    { key: 'moveTo', label: 'Mock 4 Move to…' },
  ];
  return (
    <div className="preview-toolbar">
      <span className="preview-brand">Sidetrack — UX Preview</span>
      {surfaces.map((surface) => (
        <button
          key={surface.key}
          type="button"
          className={'btn ' + (active === surface.key ? 'btn-primary' : 'btn-ghost')}
          onClick={() => {
            onPick(surface.key);
          }}
        >
          {surface.label}
        </button>
      ))}
    </div>
  );
}

function PreviewSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="preview-section">
      <h3 className="preview-section-title">{title}</h3>
      <div className="preview-section-body">{children}</div>
    </section>
  );
}
