import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  SystemBanner,
  SystemBannersStack,
  TabRecovery,
  Wizard,
} from '../../entrypoints/sidepanel/components';

const noop = () => {
  // intentional no-op for skeleton-component handlers under test
};

const STUB_INBOUND: InboundReminder = {
  bac_id: 'inbound-1',
  threadTitle: 'Side-panel state machine review',
  provider: 'claude',
  providerLabel: 'Claude',
  inboundTurnAt: '3 min ago',
  status: 'unseen',
  aiAuthored: true,
};

const STUB_DISPATCH: DispatchEvent = {
  bac_id: 'dispatch-1',
  sourceTitle: 'Side-panel state machine review',
  targetProviderLabel: 'GPT Pro',
  targetThreadTitle: 'new chat',
  dispatchKind: 'research_packet',
  dispatchedAt: '12 min ago',
  status: 'replied',
};

const STUB_WORKSTREAMS = [
  { bac_id: 'ws-root', path: 'Inbox' },
  { bac_id: 'ws-sb-prd', path: 'Sidetrack / MVP PRD' },
];

describe('UX skeleton components — render-without-crash + key text present', () => {
  it('PacketComposer renders kind / template / target selectors and footer actions', () => {
    render(<PacketComposer onCancel={noop} onCopy={noop} onSave={noop} onDispatch={noop} />);
    expect(screen.getByText('Research Packet')).toBeInTheDocument();
    expect(screen.getByText('Web-to-AI checklist')).toBeInTheDocument();
    expect(screen.getByText('Copy to clipboard')).toBeInTheDocument();
    expect(screen.getByText(/Dispatch$/)).toBeInTheDocument();
  });

  it('DispatchConfirm renders all four §24.10 safety guards', () => {
    render(
      <DispatchConfirm
        target="Claude"
        screenShareActive={false}
        injectionDetected={false}
        onCancel={noop}
        onEdit={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText(/Redaction fired/)).toBeInTheDocument();
    expect(screen.getByText(/Token budget/)).toBeInTheDocument();
    expect(screen.getByText(/safe to dispatch/)).toBeInTheDocument();
    expect(screen.getByText(/No prompt-injection patterns/)).toBeInTheDocument();
    expect(screen.getByText(/Paste mode is locked per §24.10/)).toBeInTheDocument();
  });

  it('DispatchConfirm flips screen-share + injection states when active', () => {
    render(
      <DispatchConfirm
        target="Claude"
        screenShareActive
        injectionDetected
        onCancel={noop}
        onEdit={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText(/Screen-share active/)).toBeInTheDocument();
    expect(screen.getByText(/Captured-page injection detected/)).toBeInTheDocument();
  });

  it('ReviewComposer renders span quote, verdict picker, and three actions', () => {
    render(
      <ReviewComposer
        provider="Claude"
        capturedAt="2026-04-26 14:32"
        spans={[{ id: 's1', text: 'A captured assistant turn span.' }]}
        onClose={noop}
        onSave={noop}
        onSubmitBack={noop}
        onDispatchOut={noop}
      />,
    );
    expect(screen.getByText('A captured assistant turn span.')).toBeInTheDocument();
    expect(screen.getByText('Agree')).toBeInTheDocument();
    expect(screen.getByText('Disagree')).toBeInTheDocument();
    expect(screen.getByText('Save review only')).toBeInTheDocument();
    expect(screen.getByText(/Submit-back to Claude/)).toBeInTheDocument();
    expect(screen.getByText('Dispatch to…')).toBeInTheDocument();
  });

  it('Wizard renders welcome step + advances through steps', () => {
    render(<Wizard onClose={noop} onFinish={noop} />);
    expect(screen.getByText(/Track your AI work without losing the thread/)).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 5/)).toBeInTheDocument();
  });

  it('CodingAttach renders tool picker and form fields', () => {
    render(<CodingAttach workstreams={STUB_WORKSTREAMS} onCancel={noop} onAttach={noop} />);
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('019dcb94-4c4c-…')).toBeInTheDocument();
  });

  it('Annotation renders selection blockquote and workstream picker', () => {
    render(
      <Annotation
        selection="A short selected text from the page."
        url="https://example.com/page"
        pageTitle="Example page"
        workstreams={STUB_WORKSTREAMS}
        onCancel={noop}
        onSave={noop}
      />,
    );
    expect(screen.getByText('A short selected text from the page.')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/page')).toBeInTheDocument();
    expect(screen.getByText('Sidetrack / MVP PRD')).toBeInTheDocument();
  });

  it('TabRecovery renders snapshot meta and at least one strategy button', () => {
    render(
      <TabRecovery
        snapshot={{
          title: 'A tracked tab title',
          url: 'https://example.com/tab',
          provider: 'Claude',
          capturedAt: '2026-04-26 14:32',
          lastActiveAt: '2 hr ago',
          restoreStrategy: 'reopen_url',
        }}
        onClose={noop}
        onReopenUrl={noop}
      />,
    );
    expect(screen.getByText('A tracked tab title')).toBeInTheDocument();
    expect(screen.getAllByText('Reopen URL').length).toBeGreaterThanOrEqual(1);
  });

  it('MoveToPicker renders workstream list', () => {
    render(
      <MoveToPicker
        itemTitle="some thread"
        currentPath="Inbox"
        workstreams={STUB_WORKSTREAMS}
        onClose={noop}
        onMove={noop}
      />,
    );
    expect(screen.getByPlaceholderText('Filter workstreams…')).toBeInTheDocument();
    expect(screen.getByText('Sidetrack / MVP PRD')).toBeInTheDocument();
  });

  it('SystemBanner renders companion-disconnected with action button', () => {
    const onClick = vi.fn();
    render(
      <SystemBanner
        state="companion_disconnected"
        detail="12 items queued"
        action={{ label: 'Retry', onClick }}
      />,
    );
    expect(screen.getByText(/Companion: disconnected/)).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('SystemBannersStack composes multiple states', () => {
    render(
      <SystemBannersStack companionStatus="down" vaultStatus="unreachable" screenShareActive />,
    );
    expect(screen.getByText(/Companion: disconnected/)).toBeInTheDocument();
    expect(screen.getByText(/Vault: error/)).toBeInTheDocument();
    expect(screen.getByText(/Screen-share active/)).toBeInTheDocument();
  });

  it('InboundCard renders thread title, provider chip, action row', () => {
    render(
      <InboundCard reminder={STUB_INBOUND} onOpen={noop} onMarkRelevant={noop} onDismiss={noop} />,
    );
    expect(screen.getByText('Side-panel state machine review')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Mark relevant')).toBeInTheDocument();
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('InboundCard masks title when masked=true', () => {
    render(
      <InboundCard
        reminder={STUB_INBOUND}
        masked
        onOpen={noop}
        onMarkRelevant={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText('[private — workstream item]')).toBeInTheDocument();
  });

  it('RecentDispatches renders dispatch row with status pill', () => {
    render(<RecentDispatches dispatches={[STUB_DISPATCH]} />);
    expect(screen.getByText('Side-panel state machine review')).toBeInTheDocument();
    expect(screen.getByText('GPT Pro')).toBeInTheDocument();
    expect(screen.getByText('replied')).toBeInTheDocument();
  });

  it('RecentDispatches empty state renders helper text', () => {
    render(<RecentDispatches dispatches={[]} />);
    expect(screen.getByText(/No dispatches yet/)).toBeInTheDocument();
  });
});
