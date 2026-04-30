import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewComposer } from '../../entrypoints/sidepanel/components/ReviewComposer';

const noop = () => undefined;

const renderComposer = (overrides: Partial<Parameters<typeof ReviewComposer>[0]> = {}) =>
  render(
    <ReviewComposer
      provider="Claude"
      capturedAt="just now"
      spans={[{ id: 's1', text: 'A captured assistant turn span.' }]}
      onClose={noop}
      onSave={noop}
      onSubmitBack={noop}
      onDispatchOut={noop}
      {...overrides}
    />,
  );

describe('ReviewComposer — order + defaults', () => {
  it('renders Verdict before Reviewer note (thesis-first reading order)', () => {
    renderComposer();
    const labels = screen
      .getAllByText(/Verdict|Reviewer note/, { selector: 'label' })
      .map((node) => node.textContent);
    expect(labels[0]).toBe('Verdict');
    expect(labels[1]).toBe('Reviewer note');
  });

  it('does not pre-select a verdict (no biased default)', () => {
    renderComposer();
    // None of the verdict pills should carry the .on selection class
    // when the form first opens.
    const verdictButtons = screen.getAllByRole('button', {
      name: /Agree|Disagree|Partial|Needs source|Open/,
    });
    expect(verdictButtons.every((btn) => !btn.className.includes(' on'))).toBe(true);
  });

  it('honours an explicit defaultVerdict when caller passes one', () => {
    renderComposer({ defaultVerdict: 'agree' });
    const agree = screen.getByRole('button', { name: 'Agree' });
    expect(agree.className).toContain('on');
  });
});

describe('ReviewComposer — note-gate on side-effect actions', () => {
  it('disables Submit-back and Dispatch-to until a reviewer note is typed', () => {
    renderComposer();
    const submitBack = screen.getByRole('button', { name: /Submit-back to Claude/ });
    const dispatchOut = screen.getByRole('button', { name: /Dispatch to…/ });
    const save = screen.getByRole('button', { name: 'Save review' });
    expect(submitBack).toBeDisabled();
    expect(dispatchOut).toBeDisabled();
    // Save is the always-safe terminal action — never gated.
    expect(save).not.toBeDisabled();
  });

  it('enables Submit-back + Dispatch-to once the user types a note', () => {
    renderComposer();
    const note = screen.getByPlaceholderText(/Overall: what's right/);
    fireEvent.change(note, { target: { value: 'My actual feedback' } });
    expect(screen.getByRole('button', { name: /Submit-back to Claude/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Dispatch to…/ })).not.toBeDisabled();
  });
});

describe('ReviewComposer — live state passes through to handlers', () => {
  it('Save passes the typed verdict + note + per-span comments', () => {
    const onSave = vi.fn();
    renderComposer({ onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Disagree' }));
    fireEvent.change(screen.getByPlaceholderText(/Overall: what's right/), {
      target: { value: 'The reasoning has a gap at step 3.' },
    });
    fireEvent.change(screen.getByPlaceholderText('Comment on this span…'), {
      target: { value: 'Source for this claim?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      verdict: 'disagree',
      reviewerNote: 'The reasoning has a gap at step 3.',
      perSpan: { s1: 'Source for this claim?' },
    });
  });

  it('Submit-back passes the live payload, NOT a synthetic placeholder', () => {
    // Regression guard for the bug we just fixed — the old onSubmitBack
    // signature was `() => void` and threw away the typed state.
    const onSubmitBack = vi.fn();
    renderComposer({ onSubmitBack });
    fireEvent.change(screen.getByPlaceholderText(/Overall: what's right/), {
      target: { value: 'Looks good but cite sources.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Needs source' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit-back to Claude/ }));
    expect(onSubmitBack).toHaveBeenCalledTimes(1);
    expect(onSubmitBack).toHaveBeenCalledWith({
      verdict: 'needs_source',
      reviewerNote: 'Looks good but cite sources.',
      perSpan: {},
    });
  });

  it('Dispatch-to passes the live payload', () => {
    const onDispatchOut = vi.fn();
    renderComposer({ onDispatchOut });
    fireEvent.change(screen.getByPlaceholderText(/Overall: what's right/), {
      target: { value: 'Need a fan-out review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Dispatch to…/ }));
    expect(onDispatchOut).toHaveBeenCalledTimes(1);
    const call = onDispatchOut.mock.calls[0]?.[0] as {
      verdict: string;
      reviewerNote: string;
    };
    expect(call.reviewerNote).toBe('Need a fan-out review.');
    // No verdict picked → defaults to 'open' (neutral) on outbound.
    expect(call.verdict).toBe('open');
  });
});
