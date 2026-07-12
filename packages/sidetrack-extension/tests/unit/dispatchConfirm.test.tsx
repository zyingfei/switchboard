import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DispatchConfirm } from '../../entrypoints/sidepanel/components/DispatchConfirm';
import {
  OUTBOUND_TOKEN_THRESHOLDS,
  preflightOutbound,
} from '../../src/dispatch/outboundPreflight';

// F31 — the companion's token budget must be surfaced in the confirm
// modal with per-provider thresholds (not the old hardcoded 8000).
describe('DispatchConfirm token budget', () => {
  const baseProps = {
    target: 'ChatGPT',
    body: 'Some packet body.',
    onCancel: vi.fn(),
    onEdit: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('renders the token estimate against the per-provider threshold', () => {
    render(
      <DispatchConfirm
        {...baseProps}
        tokenEstimate={5_000}
        tokenLimit={OUTBOUND_TOKEN_THRESHOLDS.chatgpt}
      />,
    );
    // 5,000 / 128,000 — the row shows both the estimate and the limit.
    expect(screen.getByText(/5,000/)).toBeInTheDocument();
    expect(screen.getByText(/128,000/)).toBeInTheDocument();
  });

  it('disables Confirm and marks the row over budget past the threshold', () => {
    render(
      <DispatchConfirm
        {...baseProps}
        tokenEstimate={OUTBOUND_TOKEN_THRESHOLDS.chatgpt + 5_000}
        tokenLimit={OUTBOUND_TOKEN_THRESHOLDS.chatgpt}
      />,
    );
    const confirm = screen.getByRole('button', { name: /confirm dispatch/i });
    expect(confirm).toBeDisabled();
  });

  it('leaves Confirm enabled when the packet fits the provider window', () => {
    render(
      <DispatchConfirm
        {...baseProps}
        tokenEstimate={1_000}
        tokenLimit={OUTBOUND_TOKEN_THRESHOLDS.claude}
      />,
    );
    const confirm = screen.getByRole('button', { name: /confirm dispatch/i });
    expect(confirm).not.toBeDisabled();
  });

  it('surfaces the captured-page injection verdict in the safety chain', () => {
    render(<DispatchConfirm {...baseProps} tokenEstimate={100} injectionDetected />);
    expect(screen.getByText(/injection detected/i)).toBeInTheDocument();
  });
});

// F01 (MAJOR + minor) — the confirm modal, given the live preflight
// verdict App.tsx now computes, must show an HONEST redaction chip and
// preview the SAFE text that actually ships (never a fake "no PII"
// verdict, never the raw secret-bearing body).
describe('DispatchConfirm redaction verdict + preview honesty', () => {
  const rawBody = [
    'openai key sk-' + 'a'.repeat(48),
    'contact owner@example.com',
  ].join('\n');
  const verdict = preflightOutbound(rawBody, 'chatgpt');
  const modalProps = (redactedClipboard: boolean) => ({
    target: 'ChatGPT',
    // Preview mirrors App.tsx: safeText when the flag is ON, raw when OFF.
    body: redactedClipboard ? verdict.safeText : rawBody,
    tokenEstimate: 100,
    redactedCount: verdict.redaction.matched,
    redactedKinds: verdict.redaction.rules,
    onCancel: vi.fn(),
    onEdit: vi.fn(),
    onConfirm: vi.fn(),
  });

  it('shows a NON-zero verdict for a body carrying an API key / email', () => {
    render(<DispatchConfirm {...modalProps(true)} />);
    // Not the fake "no PII / API-key patterns detected" verdict.
    expect(screen.queryByText(/no PII \/ API-key patterns detected/i)).not.toBeInTheDocument();
    // The real masked-span count + kinds are shown in the chip detail
    // (distinctive "masked — <kinds>" phrasing; the preview never uses it).
    expect(screen.getByText(/masked — .*openai-key/i)).toBeInTheDocument();
    expect(screen.getByText(/masked — .*email/i)).toBeInTheDocument();
  });

  it('previews the SCRUBBED text that ships (flag ON, default) — not the raw secret', () => {
    render(<DispatchConfirm {...modalProps(true)} />);
    expect(screen.getByText(/\[openai-key\]/)).toBeInTheDocument();
    expect(screen.queryByText(/sk-aaa/)).not.toBeInTheDocument();
    expect(screen.queryByText(/owner@example\.com/)).not.toBeInTheDocument();
  });

  it('with the redactedClipboard opt-out OFF, previews the raw body that ships', () => {
    render(<DispatchConfirm {...modalProps(false)} />);
    // The raw secret is what actually ships, so the preview must show it.
    expect(screen.getByText(/sk-aaa/)).toBeInTheDocument();
    // The verdict still honestly reports the detected spans.
    expect(screen.getByText(/masked/i)).toBeInTheDocument();
  });

  it('shows "no PII detected" only for a genuinely clean body', () => {
    const clean = preflightOutbound('Plain packet body, nothing sensitive.', 'chatgpt');
    render(
      <DispatchConfirm
        target="ChatGPT"
        body={clean.safeText}
        tokenEstimate={100}
        redactedCount={clean.redaction.matched}
        redactedKinds={clean.redaction.rules}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/no PII \/ API-key patterns detected/i)).toBeInTheDocument();
  });
});
