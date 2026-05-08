import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackButtons } from './FeedbackButtons';

describe('FeedbackButtons', () => {
  it('renders the compact confirm/reject controls', () => {
    const { asFragment } = render(<FeedbackButtons onFeedback={() => ({ ok: true })} />);

    expect(screen.getByTestId('feedback-confirm')).toBeDefined();
    expect(screen.getByTestId('feedback-reject')).toBeDefined();
    expect(asFragment()).toMatchSnapshot();
  });

  it('submits thumbs-up and thumbs-down choices', async () => {
    const onFeedback = vi.fn(() => Promise.resolve({ ok: true }));
    render(<FeedbackButtons label="relation" onFeedback={onFeedback} />);

    fireEvent.click(screen.getByTestId('feedback-confirm'));
    await waitFor(() => {
      expect(onFeedback).toHaveBeenCalledWith('confirm');
    });
    expect(await screen.findByTestId('feedback-saved')).toBeDefined();

    fireEvent.click(screen.getByTestId('feedback-reject'));
    await waitFor(() => {
      expect(onFeedback).toHaveBeenCalledWith('reject');
    });
  });

  it('surfaces failed submissions without marking the choice saved', async () => {
    render(
      <FeedbackButtons
        onFeedback={() => Promise.resolve({ ok: false, error: 'companion offline' })}
      />,
    );

    fireEvent.click(screen.getByTestId('feedback-reject'));

    expect(await screen.findByTestId('feedback-error')).toHaveTextContent('companion offline');
    expect(screen.queryByTestId('feedback-saved')).toBeNull();
  });
});
