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
      onSendBack={noop}
      onDispatchOut={noop}
      {...overrides}
    />,
  );

describe('ReviewComposer — verdict is optional + de-emphasized', () => {
  it('hides the verdict pills behind a disclosure by default', () => {
    renderComposer();
    expect(screen.queryByRole('button', { name: 'Agree' })).toBeNull();
    expect(screen.getByRole('button', { name: /add verdict/i })).toBeInTheDocument();
  });

  it('opens the verdict picker when "+ add verdict" is clicked', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: /add verdict/i }));
    expect(screen.getByRole('button', { name: 'Agree' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disagree' })).toBeInTheDocument();
  });

  it('honours an explicit defaultVerdict by opening the picker pre-selected', () => {
    renderComposer({ defaultVerdict: 'agree' });
    const agree = screen.getByRole('button', { name: 'Agree' });
    expect(agree.className).toContain('on');
  });

  it('toggles a verdict off when its pill is clicked twice', () => {
    renderComposer({ defaultVerdict: 'agree' });
    const agree = screen.getByRole('button', { name: 'Agree' });
    fireEvent.click(agree);
    expect(agree.className).not.toContain('on');
  });
});

describe('ReviewComposer — comment-driven gating', () => {
  it('disables Send-back and Dispatch-to until any comment is typed', () => {
    renderComposer();
    expect(screen.getByRole('button', { name: /Send back to Claude/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Dispatch to other AI/i })).toBeDisabled();
    // Save-only is always available — it's the safe path.
    expect(screen.getByRole('button', { name: 'Save only' })).not.toBeDisabled();
  });

  it('enables Send-back when the per-span comment field has text', () => {
    renderComposer();
    fireEvent.change(screen.getByPlaceholderText(/right, what's wrong/), {
      target: { value: 'Source for this claim?' },
    });
    expect(screen.getByRole('button', { name: /Send back to Claude/i })).not.toBeDisabled();
  });

  it('enables Send-back when only the overall note is typed', () => {
    renderComposer();
    fireEvent.change(screen.getByPlaceholderText(/ties the per-span/), {
      target: { value: 'Solid summary, missing one citation.' },
    });
    expect(screen.getByRole('button', { name: /Send back to Claude/i })).not.toBeDisabled();
  });
});

describe('ReviewComposer — inline span editing', () => {
  it('renders the captured span as an editable textarea', () => {
    renderComposer({
      spans: [{ id: 'sX', text: 'original captured text' }],
    });
    const editor = screen.getByDisplayValue('original captured text');
    expect(editor.tagName).toBe('TEXTAREA');
  });

  it('passes the edited span text in the payload', () => {
    const onSave = vi.fn();
    renderComposer({
      spans: [{ id: 'sX', text: 'original' }],
      onSave,
    });
    fireEvent.change(screen.getByDisplayValue('original'), {
      target: { value: 'corrected wording' },
    });
    fireEvent.change(screen.getByPlaceholderText(/right, what's wrong/), {
      target: { value: 'fixed transcription' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save only' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        spanText: { sX: 'corrected wording' },
        perSpan: { sX: 'fixed transcription' },
      }),
    );
  });
});

describe('ReviewComposer — live state passes through to handlers', () => {
  it('Send-back passes the live payload (including null verdict)', () => {
    const onSendBack = vi.fn();
    renderComposer({ onSendBack });
    fireEvent.change(screen.getByPlaceholderText(/right, what's wrong/), {
      target: { value: 'Need a citation here.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send back to Claude/i }));
    expect(onSendBack).toHaveBeenCalledTimes(1);
    expect(onSendBack).toHaveBeenCalledWith({
      verdict: null,
      reviewerNote: '',
      perSpan: { s1: 'Need a citation here.' },
      spanText: { s1: 'A captured assistant turn span.' },
    });
  });

  it('Save passes the live verdict when one was picked', () => {
    const onSave = vi.fn();
    renderComposer({ onSave });
    fireEvent.click(screen.getByRole('button', { name: /add verdict/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disagree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save only' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'disagree' }),
    );
  });
});
