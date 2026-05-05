import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  Annotation,
  CodingAttach,
  DispatchConfirm,
  HealthPanel,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UX skeleton components — render-without-crash + key text present', () => {
  it('PacketComposer renders intent picker / framing / target selectors and footer actions', () => {
    render(<PacketComposer onCancel={noop} onCopy={noop} onSave={noop} onDispatch={noop} />);
    // Intent-first picker replaces the old "Packet kind" pill row;
    // default intent = "Ask another AI" so framing field renders.
    expect(screen.getByRole('button', { name: 'Ask another AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hand to a coding agent' })).toBeInTheDocument();
    expect(screen.getByText('Critique')).toBeInTheDocument();
    // Footer is now a primary Dispatch + a split-button caret. Copy /
    // Save live in the menu, opened via the caret — they're not in the
    // initial DOM.
    expect(screen.getByRole('button', { name: /Dispatch/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More packet actions/ })).toBeInTheDocument();
  });

  it('DispatchConfirm renders all four safety guards (clean state)', () => {
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
    // SafetyChainSummary collapses the four checks into a single
    // summary line. Clean state → "checks ok" header (no "redaction" pip
    // in warn state). Regression guard for the "0 items removed — 1
    // GitHub token, 1 email" contradictory copy bug.
    expect(screen.queryByText(/Redaction fired/)).toBeNull();
    expect(screen.queryByText(/1 GitHub token/)).toBeNull();
    expect(screen.getByText(/checks ok/)).toBeInTheDocument();
    // Pips render the four check labels in the collapsed summary.
    expect(screen.getAllByText(/redaction/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/token budget/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/screen-share-safe/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/injection scrub/i).length).toBeGreaterThan(0);
    // Mode pills are present; auto-send is locked when not opted-in.
    expect(screen.getByRole('button', { name: /Paste mode/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Auto-send/ })).toBeDisabled();
    // Internal section markers should never bleed into user-visible
    // copy. Regression guard for the §24.10 / ADR-0001 leaks the user
    // flagged.
    expect(screen.queryByText(/§24\.10/)).toBeNull();
    expect(screen.queryByText(/ADR-0001/)).toBeNull();
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
    expect(pre?.textContent ?? '').toContain("This is the user's real composed packet.");
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
    // With redactedCount > 0, the summary auto-opens (warn) and the
    // detail row shows the masked-spans note. The summary header reads
    // "needs review" instead of "checks ok".
    expect(screen.getByText(/needs review/)).toBeInTheDocument();
    expect(screen.getByText(/2 spans masked — 1 GitHub token, 1 email/)).toBeInTheDocument();
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
    // Both warnings auto-open the safety chain detail; check for the
    // detail-row prose now that the inline rich rows are collapsed.
    expect(screen.getByText(/needs review/)).toBeInTheDocument();
    expect(
      screen.getByText(/screen-share active — contents visible to viewers/),
    ).toBeInTheDocument();
    expect(screen.getByText(/captured-page injection detected/)).toBeInTheDocument();
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
    expect(screen.getByDisplayValue('A captured assistant turn span.')).toBeInTheDocument();
    // Verdict picker is hidden behind a disclosure — only the
    // disclosure button is in the initial DOM.
    expect(screen.getByRole('button', { name: /add verdict/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agree' })).toBeNull();
    // Three terminal actions: Save only / Dispatch to other AI / Send back.
    expect(screen.getByRole('button', { name: 'Save only' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dispatch to other AI/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send back to Claude/ })).toBeInTheDocument();
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
    // Vault step is now first after Welcome; advance twice to reach
    // the Companion step.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
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
    // Vault step is now first after Welcome (vaultPath defaults to
    // '~/Documents/Sidetrack-vault' so the npx command can render
    // it). Next twice → companion step.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
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
    // Vault step is now first after Welcome (vaultPath defaults to
    // '~/Documents/Sidetrack-vault' so the npx command can render
    // it). Next twice → companion step.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paste from clipboard' }));
    expect(await screen.findByText(/Bridge key malformed/)).toBeInTheDocument();
    expect(onBridgeKeyChange).not.toHaveBeenCalled();
  });

  it('Wizard companion step names missing and malformed bridge keys before continuing', () => {
    const onBridgeKeyChange = vi.fn();
    const renderWizard = (bridgeKey = '') => (
      <Wizard
        bridgeKey={bridgeKey}
        onClose={noop}
        onFinish={noop}
        onBridgeKeyChange={onBridgeKeyChange}
        onPingCompanion={vi.fn().mockResolvedValue('unreachable' as const)}
        onReadClipboard={vi.fn().mockResolvedValue('')}
      />
    );
    const { rerender } = render(renderWizard());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Bridge key missing/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/bridge key/i), { target: { value: 'short' } });
    rerender(renderWizard('short'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Bridge key malformed/)).toBeInTheDocument();
    expect(onBridgeKeyChange).toHaveBeenCalledWith('short');
  });

  it('Wizard returns to the companion step when the bridge key is rejected', async () => {
    render(
      <Wizard
        bridgeKey={'a'.repeat(43)}
        connectionError="Bridge key rejected — this companion is running with a different vault key."
        onClose={noop}
        onFinish={noop}
        onPingCompanion={vi.fn().mockResolvedValue('unreachable' as const)}
        onReadClipboard={vi.fn().mockResolvedValue('')}
      />,
    );
    expect(await screen.findByText(/Bridge key rejected/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/bridge key/i)).toBeInTheDocument();
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

  it('HealthPanel shows an unavailable state instead of preview fixture data', () => {
    render(<HealthPanel onClose={noop} />);

    expect(screen.getByText('Companion not configured')).toBeInTheDocument();
    expect(screen.queryByText('~/Documents/Sidetrack-vault')).not.toBeInTheDocument();
    expect(screen.queryByText('12.4k')).not.toBeInTheDocument();
  });

  it('HealthPanel renders live queue, provider, and recall activity data', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              uptimeSec: 42,
              vault: { root: '/tmp/sidetrack-vault', writable: true, sizeBytes: 2048 },
              capture: {
                lastByProvider: { chatgpt: '2026-05-05T00:00:00.000Z' },
                queueDepthHint: null,
                droppedHint: null,
                providers: [
                  {
                    provider: 'chatgpt',
                    lastCaptureAt: '2026-05-05T00:00:00.000Z',
                    lastStatus: 'warning',
                    ok24h: 2,
                    warn24h: 1,
                    fail24h: 0,
                    warning: 'Visible text is unusually long.',
                  },
                ],
                recentWarnings: [
                  {
                    provider: 'chatgpt',
                    capturedAt: '2026-05-05T00:00:00.000Z',
                    code: 'long_capture',
                    message: 'Visible text is unusually long.',
                    severity: 'warning',
                  },
                ],
              },
              recall: {
                indexExists: true,
                entryCount: 5,
                modelId: 'test/model',
                sizeBytes: 4096,
                status: 'ready',
                activity: {
                  lastIndexedAt: '2026-05-05T00:01:00.000Z',
                  lastIndexedCount: 3,
                  lastIndexedThreadIds: ['bac_thread_1'],
                  lastRecallQueryAt: null,
                  lastRecallQueryResultCount: null,
                  lastSuggestionAt: '2026-05-05T00:02:00.000Z',
                  lastSuggestionThreadId: 'bac_thread_1',
                  recent: [
                    {
                      kind: 'suggestion',
                      at: '2026-05-05T00:02:00.000Z',
                      threadId: 'bac_thread_1',
                      resultCount: 1,
                    },
                  ],
                },
              },
              service: { installed: true, running: true },
            },
          }),
      }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    render(
      <HealthPanel
        onClose={noop}
        companionPort={17_373}
        bridgeKey="bridge"
        queuedCaptureCount={4}
        droppedCaptureCount={1}
      />,
    );

    expect(await screen.findByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('queued captures')).toBeInTheDocument();
    expect(screen.getByText(/dropped 1/)).toBeInTheDocument();
    expect(screen.getByText(/Group recommendation/)).toBeInTheDocument();
    expect(screen.getAllByText('Visible text is unusually long.').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17373/v1/system/health', {
        headers: { 'x-bac-bridge-key': 'bridge' },
      });
    });
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
