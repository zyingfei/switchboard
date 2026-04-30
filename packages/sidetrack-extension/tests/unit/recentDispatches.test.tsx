import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  RecentDispatches,
  type DispatchEvent,
} from '../../entrypoints/sidepanel/components/RecentDispatches';

const buildEvent = (overrides: Partial<DispatchEvent> = {}): DispatchEvent => ({
  bac_id: 'd1',
  sourceTitle: 'Source thread',
  targetProviderLabel: 'Gemini',
  mode: 'paste',
  dispatchKind: 'research_packet',
  dispatchedAt: '12 min ago',
  status: 'sent',
  ...overrides,
});

describe('RecentDispatches — mode-aware actions', () => {
  it('linked row shows "↗ open" and onOpenTarget fires when clicked', () => {
    const onOpenTarget = vi.fn();
    render(
      <RecentDispatches
        dispatches={[
          buildEvent({ targetThreadTitle: 'destination chat' }),
        ]}
        onOpenTarget={onOpenTarget}
      />,
    );
    const open = screen.getByRole('button', { name: /↗ open/ });
    expect(open).toBeInTheDocument();
    fireEvent.click(open);
    expect(onOpenTarget).toHaveBeenCalledWith('d1');
    // No Copy / Dispatch buttons on linked rows.
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispatch' })).toBeNull();
  });

  it('paste-mode unlinked row shows Copy and fires onCopy', () => {
    const onCopy = vi.fn();
    const onDispatch = vi.fn();
    render(
      <RecentDispatches
        dispatches={[buildEvent({ mode: 'paste' })]}
        onCopy={onCopy}
        onDispatch={onDispatch}
      />,
    );
    const copy = screen.getByRole('button', { name: 'Copy' });
    expect(copy).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dispatch' })).toBeNull();
    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledWith('d1');
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('auto-send mode unlinked row shows Dispatch and fires onDispatch', () => {
    const onCopy = vi.fn();
    const onDispatch = vi.fn();
    render(
      <RecentDispatches
        dispatches={[buildEvent({ mode: 'auto-send' })]}
        onCopy={onCopy}
        onDispatch={onDispatch}
      />,
    );
    const dispatch = screen.getByRole('button', { name: 'Dispatch' });
    expect(dispatch).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    fireEvent.click(dispatch);
    expect(onDispatch).toHaveBeenCalledWith('d1');
    expect(onCopy).not.toHaveBeenCalled();
  });

  it('view button is always present and fires onView', () => {
    const onView = vi.fn();
    render(
      <RecentDispatches dispatches={[buildEvent()]} onView={onView} />,
    );
    const view = screen.getByRole('button', { name: 'View dispatch body' });
    fireEvent.click(view);
    expect(onView).toHaveBeenCalledWith('d1');
  });

  it('source side fires onFocusSource', () => {
    const onFocusSource = vi.fn();
    render(
      <RecentDispatches
        dispatches={[buildEvent()]}
        onFocusSource={onFocusSource}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Source thread/ }));
    expect(onFocusSource).toHaveBeenCalledWith('d1');
  });

  it('target chip text reflects link state ("destination chat" vs "pending chat")', () => {
    const { rerender } = render(
      <RecentDispatches dispatches={[buildEvent()]} />,
    );
    expect(screen.getByText('pending chat')).toBeInTheDocument();
    rerender(
      <RecentDispatches
        dispatches={[buildEvent({ targetThreadTitle: 'my new chat' })]}
      />,
    );
    expect(screen.getByText('my new chat')).toBeInTheDocument();
    expect(screen.queryByText('pending chat')).toBeNull();
  });
});
