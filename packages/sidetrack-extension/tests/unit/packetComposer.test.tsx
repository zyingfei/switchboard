import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PacketComposer } from '../../entrypoints/sidepanel/components/PacketComposer';

const noop = () => undefined;

const renderComposer = (overrides: Partial<Parameters<typeof PacketComposer>[0]> = {}) =>
  render(
    <PacketComposer
      onCancel={noop}
      onCopy={noop}
      onSave={noop}
      onDispatch={noop}
      {...overrides}
    />,
  );

describe('PacketComposer — title is owned by Scope', () => {
  it('does not render a separate Title input', () => {
    renderComposer();
    // The label "Title" is gone; the field is collapsed into the
    // click-to-rename Scope label.
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('shows the scope label as a click-to-rename button by default', () => {
    renderComposer({
      defaultTitle: 'My packet',
      scope: {
        label: 'My packet',
        meta: 'Claude · 2 min ago',
        availableTurns: [],
      },
    });
    const renameBtn = screen.getByRole('button', { name: 'My packet' });
    expect(renameBtn).toBeInTheDocument();
    // The accessible name uses the visible label; the tooltip lives
    // on the title attribute.
    expect(renameBtn.getAttribute('title')).toMatch(/rename/i);
  });

  it('flips to an input when the scope label is clicked', () => {
    renderComposer({ defaultTitle: 'X' });
    fireEvent.click(screen.getByRole('button', { name: 'X' }));
    const input = screen.getByDisplayValue('X');
    expect(input.tagName).toBe('INPUT');
  });
});

describe('PacketComposer — intent-first target lanes', () => {
  it('default intent "Ask another AI" shows AI providers and the framing field', () => {
    renderComposer();
    // The single-axis target row is labelled "Send to" inside the
    // AI-asking intent. AI provider pills are rendered.
    expect(screen.getByText('Send to')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GPT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gemini' })).toBeInTheDocument();
    // Framing row is visible inside this intent.
    expect(screen.getByText('Framing')).toBeInTheDocument();
  });

  it('switching to "Hand to a coding agent" hides framing and shows coding agents only', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Hand to a coding agent' }));
    expect(screen.queryByText('Framing')).toBeNull();
    expect(screen.getByText('Send to coding agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeInTheDocument();
    // AI providers are NOT in this lane.
    expect(screen.queryByRole('button', { name: 'Claude' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'GPT' })).toBeNull();
  });

  it('switching to "Save as reference" shows the export sinks only', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Save as reference' }));
    expect(screen.queryByText('Framing')).toBeNull();
    expect(screen.getByText('Save as')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notebook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Markdown' })).toBeInTheDocument();
  });

  it('reveals tier sub-pills (Pro / Deep Research) only when GPT is selected', () => {
    renderComposer();
    // Sub-pills are not in the DOM until the parent is selected.
    expect(screen.queryByRole('button', { name: 'Pro' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deep Research' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'GPT' }));
    expect(screen.getByRole('button', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deep Research' })).toBeInTheDocument();
  });
});

describe('PacketComposer — footer hierarchy', () => {
  it('Dispatch is the primary CTA; Copy/Save live behind a caret menu', () => {
    renderComposer();
    expect(screen.getByRole('button', { name: /Dispatch/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More packet actions' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Copy to clipboard/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Save to vault/ })).toBeNull();
  });

  it('opens the secondary menu when the caret is clicked', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'More packet actions' }));
    expect(screen.getByRole('menuitem', { name: /Copy to clipboard/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Save to vault/ })).toBeInTheDocument();
  });

  it('Copy/Save fire even with NO Target selected (target-independent)', () => {
    const onCopy = vi.fn();
    const onSave = vi.fn();
    renderComposer({ onCopy, onSave });
    fireEvent.click(screen.getByRole('button', { name: 'More packet actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy to clipboard/ }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More packet actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Save to vault/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Dispatch stays gated on a Target selection', () => {
    const onDispatch = vi.fn();
    renderComposer({ onDispatch });
    const dispatch = screen.getByRole('button', { name: /Dispatch/ });
    expect(dispatch).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
    expect(screen.getByRole('button', { name: /Dispatch/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Dispatch/ }));
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('primary CTA flips to "Export" when a file sink is selected', () => {
    const { container } = renderComposer();
    // Notebook is now only reachable inside the "Save as reference"
    // intent — switch to that intent first, then pick Notebook.
    fireEvent.click(screen.getByRole('button', { name: 'Save as reference' }));
    fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
    const cta = container.querySelector('.split-button-main');
    expect(cta?.textContent ?? '').toMatch(/Export$/);
  });
});

describe('PacketComposer — redaction line is suppressed when nothing was redacted', () => {
  it('does not render the empty-state "No sensitive items" line', () => {
    renderComposer();
    // Status-quo confirmations are noise — that row should be gone
    // when the redaction list is empty.
    expect(screen.queryByText(/No sensitive items detected/)).toBeNull();
  });

  it('shows the redaction line when items were redacted', () => {
    renderComposer({ redactedItems: [{ kind: 'email', count: 2 }] });
    expect(screen.getByText(/Redacted 2 items/)).toBeInTheDocument();
  });
});
