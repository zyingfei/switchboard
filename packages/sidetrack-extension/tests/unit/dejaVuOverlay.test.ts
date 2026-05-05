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
});
