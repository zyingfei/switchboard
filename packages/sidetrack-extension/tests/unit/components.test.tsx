import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  mode: 'paste',
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
    // Footer is now a primary Dispatch + a split-button caret. Copy /
    // Save live in the menu, opened via the caret — they're not in the
    // initial DOM.
    expect(screen.getByRole('button', { name: /Dispatch/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More packet actions/ })).toBeInTheDocument();
  });

  it('DispatchConfirm renders all four §24.10 safety guards (clean state)', () => {
    render(
      <DispatchConfirm
        target="Claude"
        body="# Real packet body\n\nThis is the user's real composed packet."
        redactedCount={0}
        tokenEstimate={1200}
        screenShareActive={false}
        injectionDetected={false}
        onCancel={noop}
        onEdit={noop}
        onConfirm={noop}
      />,
    );
    // No items redacted → friendly empty-state, NOT "Redaction fired".
    // Regression guard for the "0 items removed — 1 GitHub token, 1 email"
    // contradictory copy that was leaking from the stub defaults.
    expect(screen.queryByText(/Redaction fired/)).toBeNull();
    expect(screen.queryByText(/1 GitHub token/)).toBeNull();
    expect(screen.getByText(/Nothing redacted/)).toBeInTheDocument();
    expect(screen.getByText(/Token budget/)).toBeInTheDocument();
    expect(screen.getByText(/safe to dispatch/)).toBeInTheDocument();
    expect(screen.getByText(/No prompt-injection patterns/)).toBeInTheDocument();
    expect(screen.getByText(/Paste mode is locked per §24.10/)).toBeInTheDocument();
  });

  it('DispatchConfirm renders the actual packet body in the preview', () => {
    // Regression guard for the bug where the preview was a hardcoded
    // stub ("# Sidetrack / MVP PRD — context pack") regardless of
    // what the user composed.
    render(
      <DispatchConfirm
        target="Claude"
        body="# Real packet body\n\nThis is the user's real composed packet."
        redactedCount={0}
        tokenEstimate={1200}
        onCancel={noop}
        onEdit={noop}
        onConfirm={noop}
      />,
    );
    // <pre> renders the body with newlines, so testing-library's
    // default text-matcher won't find a substring directly. Look at
    // the rendered <pre> element's textContent instead.
    const pre = document.querySelector('pre.preview-body');
    expect(pre?.textContent ?? '').toContain(
      "This is the user's real composed packet.",
    );
    // Old stub strings must not appear.
    expect(pre?.textContent ?? '').not.toContain('Sidetrack / MVP PRD — context pack');
    expect(pre?.textContent ?? '').not.toContain('PRD §24.10 wording');
  });

  it('DispatchConfirm shows redaction details only when items were removed', () => {
    render(
      <DispatchConfirm
        target="Claude"
        body="…"
        redactedCount={2}
        redactedKinds={['1 GitHub token', '1 email']}
        tokenEstimate={1200}
        onCancel={noop}
        onEdit={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText(/Redaction fired/)).toBeInTheDocument();
    expect(screen.getByText(/2 items removed/)).toBeInTheDocument();
    expect(screen.getByText('1 GitHub token, 1 email')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing redacted/)).toBeNull();
  });

  it('DispatchConfirm flips screen-share + injection states when active', () => {
    render(
      <DispatchConfirm
        target="Claude"
        body="…"
        redactedCount={0}
        tokenEstimate={1200}
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

  it('ReviewComposer renders editable span + comment-driven actions', () => {
    render(
      <ReviewComposer
        provider="Claude"
        capturedAt="2026-04-26 14:32"
        spans={[{ id: 's1', text: 'A captured assistant turn span.' }]}
        onClose={noop}
        onSave={noop}
        onSendBack={noop}
        onDispatchOut={noop}
      />,
    );
    // Span text is now an editable textarea, not a static blockquote.
    expect(
      screen.getByDisplayValue('A captured assistant turn span.'),
    ).toBeInTheDocument();
    // Verdict picker is hidden behind a disclosure — only the
    // disclosure button is in the initial DOM.
    expect(screen.getByRole('button', { name: /add verdict/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agree' })).toBeNull();
    // Three terminal actions: Save only / Dispatch to other AI / Send back.
    expect(screen.getByRole('button', { name: 'Save only' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Dispatch to other AI/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Send back to Claude/ }),
    ).toBeInTheDocument();
  });

  it('Wizard renders welcome step + advances through steps', () => {
    render(<Wizard onClose={noop} onFinish={noop} />);
    expect(screen.getByText(/Track your AI work without losing the thread/)).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 5/)).toBeInTheDocument();
  });

  it('Wizard companion step pings via injected onPingCompanion and reflects result', async () => {
    const ping = vi.fn().mockResolvedValue('reachable' as const);
    const readClipboard = vi.fn().mockResolvedValue('');
    render(
      <Wizard
        onClose={noop}
        onFinish={noop}
        onPingCompanion={ping}
        onReadClipboard={readClipboard}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Waiting for companion/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(ping).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Companion reachable on port/)).toBeInTheDocument();
  });

  it('Wizard companion step paste-from-clipboard accepts a base64url-looking key', async () => {
    const onBridgeKeyChange = vi.fn();
    const readClipboard = vi.fn().mockResolvedValue('a'.repeat(40));
    render(
      <Wizard
        onClose={noop}
        onFinish={noop}
        onBridgeKeyChange={onBridgeKeyChange}
        onPingCompanion={vi.fn().mockResolvedValue('unreachable' as const)}
        onReadClipboard={readClipboard}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paste from clipboard' }));
    await vi.waitFor(() => {
      expect(onBridgeKeyChange).toHaveBeenCalledWith('a'.repeat(40));
    });
    expect(readClipboard).toHaveBeenCalledTimes(1);
  });

  it('Wizard companion step rejects a clipboard value that is too short', async () => {
    const onBridgeKeyChange = vi.fn();
    const readClipboard = vi.fn().mockResolvedValue('short');
    render(
      <Wizard
        onClose={noop}
        onFinish={noop}
        onBridgeKeyChange={onBridgeKeyChange}
        onPingCompanion={vi.fn().mockResolvedValue('unreachable' as const)}
        onReadClipboard={readClipboard}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paste from clipboard' }));
    expect(await screen.findByText(/doesn't look like a bridge key/)).toBeInTheDocument();
    expect(onBridgeKeyChange).not.toHaveBeenCalled();
  });

  it('CodingAttach renders the handoff modal with workstream picker', () => {
    render(
      <CodingAttach
        workstreams={STUB_WORKSTREAMS}
        companionAvailable={true}
        onCancel={noop}
        onAttached={noop}
        onCreateToken={() =>
          Promise.resolve({
            token: 'TEST_TOKEN_123',
            createdAt: '2026-04-28T00:00:00.000Z',
            expiresAt: '2026-04-28T00:05:00.000Z',
          })
        }
        onPoll={() => Promise.resolve([])}
      />,
    );
    expect(screen.getByText('Attach coding session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate prompt' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('CodingAttach disables the generate button when companion is unavailable', () => {
    render(
      <CodingAttach
        workstreams={STUB_WORKSTREAMS}
        companionAvailable={false}
        onCancel={noop}
        onAttached={noop}
        onCreateToken={() =>
          Promise.resolve({
            token: 'TEST_TOKEN_456',
            createdAt: '2026-04-28T00:00:00.000Z',
            expiresAt: '2026-04-28T00:05:00.000Z',
          })
        }
        onPoll={() => Promise.resolve([])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Generate prompt' })).toBeDisabled();
    expect(screen.getByText(/needs the companion/)).toBeInTheDocument();
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

  it('RecentDispatches renders dispatch row with linked-target action', () => {
    // STUB_DISPATCH has targetThreadTitle set, so the row counts as
    // "linked" — action collapses to "↗ open" instead of Copy/Dispatch.
    render(<RecentDispatches dispatches={[STUB_DISPATCH]} />);
    expect(screen.getByText('Side-panel state machine review')).toBeInTheDocument();
    expect(screen.getByText('GPT Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /↗ open/ })).toBeInTheDocument();
  });

  it('RecentDispatches empty state renders helper text', () => {
    render(<RecentDispatches dispatches={[]} />);
    expect(screen.getByText(/No dispatches yet/)).toBeInTheDocument();
  });
});
