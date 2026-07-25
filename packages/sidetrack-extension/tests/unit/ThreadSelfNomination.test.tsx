import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThreadSelfNomination } from '../../entrypoints/sidepanel/components/ThreadSelfNomination';

const props = (overrides: Record<string, unknown> = {}) => ({
  visitCount: 7,
  distinctDays: 3,
  suggestedTitle: 'Phantom与Shadow v2架构',
  onConfirm: vi.fn(),
  onDismiss: vi.fn(),
  ...overrides,
});

describe('ThreadSelfNomination', () => {
  it('eligible state: offers to start a workstream with an editable pre-filled title', () => {
    const p = props();
    render(<ThreadSelfNomination {...p} />);

    expect(screen.getByText('Start a workstream from this thread?')).toBeInTheDocument();
    // Honest recurrence readout drives the nudge.
    expect(screen.getByText('Seen 7 times across 3 days — no home yet')).toBeInTheDocument();
    // Title is pre-filled and editable.
    const input = screen.getByLabelText<HTMLInputElement>('New workstream name');
    expect(input.value).toBe('Phantom与Shadow v2架构');
  });

  it('confirm flow: passes the (edited) title to onConfirm on the Start button', () => {
    const p = props();
    render(<ThreadSelfNomination {...p} />);

    const input = screen.getByLabelText('New workstream name');
    fireEvent.change(input, { target: { value: 'Phantom vs Shadow architecture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start workstream' }));

    expect(p.onConfirm).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).toHaveBeenCalledWith('Phantom vs Shadow architecture');
  });

  it('confirm flow: Enter in the title field confirms', () => {
    const p = props();
    render(<ThreadSelfNomination {...p} />);

    fireEvent.keyDown(screen.getByLabelText('New workstream name'), { key: 'Enter' });
    expect(p.onConfirm).toHaveBeenCalledWith('Phantom与Shadow v2架构');
  });

  it('does not confirm an empty title', () => {
    const p = props();
    render(<ThreadSelfNomination {...p} />);

    const input = screen.getByLabelText('New workstream name');
    fireEvent.change(input, { target: { value: '   ' } });
    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start workstream' });
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it('pending state: locks the inputs and relabels Start', () => {
    render(<ThreadSelfNomination {...props({ pending: true })} />);

    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(screen.getByLabelText('New workstream name')).toBeDisabled();
  });

  it('filed state: shows the started-workstream confirmation, no editable form', () => {
    render(<ThreadSelfNomination {...props({ filedTitle: 'Phantom与Shadow v2架构' })} />);

    expect(screen.getByText('Started workstream')).toBeInTheDocument();
    expect(screen.getByText('Phantom与Shadow v2架构')).toBeInTheDocument();
    expect(screen.queryByLabelText('New workstream name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start workstream' })).toBeNull();
  });

  it('dismiss: fires onDismiss', () => {
    const p = props();
    render(<ThreadSelfNomination {...p} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
  });
});
