import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { mountDejaVuPopover } from '../../src/contentOverlays';

describe('Déjà-vu content overlay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('renders provider metadata and wires jump and mute actions', () => {
    const onJump = vi.fn();
    const onMute = vi.fn();
    mountDejaVuPopover({
      anchorRect: new DOMRect(120, 160, 40, 20),
      items: [
        {
          id: 'rank-1',
          title: 'Prior research thread',
          snippet: 'Relevant remembered snippet',
          score: 0.72,
          relativeWhen: new Date(Date.now() - 60_000).toISOString(),
          provider: 'claude',
          threadUrl: 'https://claude.ai/chat/thread-1',
        },
      ],
      onJump,
      onMute,
    });

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText(/min ago|sec ago/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(onJump).toHaveBeenCalledWith(
      expect.objectContaining({ threadUrl: 'https://claude.ai/chat/thread-1' }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Mute on this page' })[0]);
    expect(onMute).toHaveBeenCalledTimes(1);
  });

  it('allows Jump when a recall result has a bac_id but no source URL', () => {
    const onJump = vi.fn();
    mountDejaVuPopover({
      anchorRect: new DOMRect(120, 160, 40, 20),
      items: [
        {
          id: 'rank-1',
          title: 'Prior research thread',
          snippet: 'Relevant remembered snippet',
          score: 0.72,
          relativeWhen: new Date(Date.now() - 60_000).toISOString(),
          provider: 'gemini',
          bacId: 'bac_thread_recalled',
        },
      ],
      onJump,
    });

    const jump = screen.getByRole('button', { name: 'Jump' });
    expect(jump).not.toBeDisabled();
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ bacId: 'bac_thread_recalled' }));
  });

  it('does not render raw recall identifiers or scores as the visible title chrome', () => {
    mountDejaVuPopover({
      anchorRect: new DOMRect(120, 160, 40, 20),
      items: [
        {
          id: 'rank-1',
          title: 'thread 69fcb926-3a9',
          snippet: 'Relevant remembered snippet',
          score: 0.02,
          relativeWhen: new Date(Date.now() - 60_000).toISOString(),
          provider: 'chatgpt',
          bacId: 'QMPG4BZ0SQC1HMJ0',
        },
      ],
    });

    expect(screen.getByText('Recalled thread')).toBeInTheDocument();
    expect(screen.queryByText('thread 69fcb926-3a9')).not.toBeInTheDocument();
    expect(screen.queryByText('0.02')).not.toBeInTheDocument();
  });
});
