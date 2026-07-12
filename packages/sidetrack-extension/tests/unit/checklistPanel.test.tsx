import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  ChecklistPanel,
  type ChecklistPanelItem,
} from '../../entrypoints/sidepanel/components/ChecklistPanel';

const items: readonly ChecklistPanelItem[] = [
  { id: 'a', text: 'Draft the PRD', checked: false },
  { id: 'b', text: 'Review with team', checked: true },
];

describe('ChecklistPanel — §13 step 7 mutations', () => {
  it('renders items with their checked state and a progress count', () => {
    render(
      <ChecklistPanel items={items} onAdd={() => undefined} onToggle={() => undefined} onRemove={() => undefined} />,
    );
    expect(screen.getByText('1 / 2 done')).toBeInTheDocument();
    expect((screen.getByLabelText('Draft the PRD') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Review with team') as HTMLInputElement).checked).toBe(true);
  });

  it('adds a new item on Enter and clears the input', () => {
    const onAdd = vi.fn();
    render(
      <ChecklistPanel items={items} onAdd={onAdd} onToggle={() => undefined} onRemove={() => undefined} />,
    );
    const input = screen.getByLabelText('Add a checklist item') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ship it' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('Ship it');
    expect(input.value).toBe('');
  });

  it('does not add blank text', () => {
    const onAdd = vi.fn();
    render(
      <ChecklistPanel items={items} onAdd={onAdd} onToggle={() => undefined} onRemove={() => undefined} />,
    );
    const input = screen.getByLabelText('Add a checklist item');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('ticks and unticks items', () => {
    const onToggle = vi.fn();
    render(
      <ChecklistPanel items={items} onAdd={() => undefined} onToggle={onToggle} onRemove={() => undefined} />,
    );
    fireEvent.click(screen.getByLabelText('Draft the PRD'));
    expect(onToggle).toHaveBeenCalledWith('a', true);
    fireEvent.click(screen.getByLabelText('Review with team'));
    expect(onToggle).toHaveBeenCalledWith('b', false);
  });

  it('removes an item', () => {
    const onRemove = vi.fn();
    render(
      <ChecklistPanel items={items} onAdd={() => undefined} onToggle={() => undefined} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Draft the PRD' }));
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('shows the empty state when there are no items', () => {
    render(
      <ChecklistPanel items={[]} onAdd={() => undefined} onToggle={() => undefined} onRemove={() => undefined} />,
    );
    expect(screen.getByText('No checklist items yet.')).toBeInTheDocument();
  });

  it('disables inputs while busy', () => {
    render(
      <ChecklistPanel
        items={items}
        onAdd={() => undefined}
        onToggle={() => undefined}
        onRemove={() => undefined}
        busy
      />,
    );
    expect((screen.getByLabelText('Draft the PRD') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Add a checklist item') as HTMLInputElement).disabled).toBe(true);
  });
});
