import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DispatchConfirm } from '../../entrypoints/sidepanel/components/DispatchConfirm';
import { OUTBOUND_TOKEN_THRESHOLDS } from '../../src/dispatch/outboundPreflight';

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
