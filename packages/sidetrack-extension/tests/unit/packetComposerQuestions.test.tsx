import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PacketComposer } from '../../entrypoints/sidepanel/components/PacketComposer';

const noop = () => undefined;

const renderWithQueue = () =>
  render(
    <PacketComposer
      onCancel={noop}
      onCopy={noop}
      onSave={noop}
      onDispatch={noop}
      defaultTemplate="critique"
      scope={{ label: 'MVP PRD', availableTurns: [{ role: 'assistant', text: 'Prior answer.' }] }}
      queueItems={[
        { bac_id: 'q1', text: 'Does this handle the offline case?' },
        { bac_id: 'q2', text: 'What is the token budget?' },
      ]}
    />,
  );

describe('PacketComposer — §13 step 11 queue → Questions section', () => {
  it('renders the queued-asks picker when queue items are supplied', () => {
    renderWithQueue();
    expect(screen.getByText('Queued asks')).toBeInTheDocument();
    expect(screen.getByText('Does this handle the offline case?')).toBeInTheDocument();
    expect(screen.getByText('What is the token budget?')).toBeInTheDocument();
  });

  it('folds selected asks into a Questions section in the body', () => {
    renderWithQueue();
    const body = screen.getByRole('textbox', { name: '' }) as HTMLTextAreaElement;
    // Body has no Questions section until an ask is ticked.
    expect(body.value).not.toContain('## Questions');

    fireEvent.click(screen.getByLabelText('Does this handle the offline case?'));
    const updated = (screen.getByRole('textbox', { name: '' }) as HTMLTextAreaElement).value;
    expect(updated).toContain('## Questions');
    expect(updated).toContain('- Does this handle the offline case?');
    expect(updated).not.toContain('- What is the token budget?');
  });

  it('adds a second selected ask as another bullet', () => {
    renderWithQueue();
    fireEvent.click(screen.getByLabelText('Does this handle the offline case?'));
    fireEvent.click(screen.getByLabelText('What is the token budget?'));
    const body = (screen.getByRole('textbox', { name: '' }) as HTMLTextAreaElement).value;
    expect(body).toContain('- Does this handle the offline case?');
    expect(body).toContain('- What is the token budget?');
  });

  it('hides the picker when there are no queue items', () => {
    render(<PacketComposer onCancel={noop} onCopy={noop} onSave={noop} onDispatch={noop} />);
    expect(screen.queryByText('Queued asks')).toBeNull();
  });
});
