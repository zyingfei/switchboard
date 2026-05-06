import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { WorkstreamDetailPanel } from '../../entrypoints/sidepanel/components';

const TREE = [
  { bac_id: 'ws_root_a', title: 'Parent A' },
  { bac_id: 'ws_root_b', title: 'Parent B' },
  { bac_id: 'ws_sub', title: 'Sub group', parentId: 'ws_root_a' },
];

describe('WorkstreamDetailPanel — rename + move', () => {
  it('renames inline when title is clicked and Enter is pressed', () => {
    const onRename = vi.fn();
    render(
      <WorkstreamDetailPanel
        workstreamLabel="Sub group"
        workstream={{ bac_id: 'ws_sub', title: 'Sub group', parentId: 'ws_root_a' }}
        workstreams={TREE}
        linkedNotes={[]}
        trustEntries={[]}
        onClose={() => undefined}
        onTrustChange={() => undefined}
        onRename={onRename}
        onMove={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText('Sub group'));
    const input = screen.getByLabelText('Rename workstream') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Sub renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Sub renamed');
  });

  it('escape cancels the rename without firing onRename', () => {
    const onRename = vi.fn();
    render(
      <WorkstreamDetailPanel
        workstreamLabel="Sub group"
        workstream={{ bac_id: 'ws_sub', title: 'Sub group' }}
        workstreams={TREE}
        linkedNotes={[]}
        trustEntries={[]}
        onClose={() => undefined}
        onTrustChange={() => undefined}
        onRename={onRename}
        onMove={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText('Sub group'));
    const input = screen.getByLabelText('Rename workstream') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'should not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('shows "Sub-group of <parent>" when the workstream has a parent', () => {
    render(
      <WorkstreamDetailPanel
        workstreamLabel="Sub group"
        workstream={{ bac_id: 'ws_sub', title: 'Sub group', parentId: 'ws_root_a' }}
        workstreams={TREE}
        linkedNotes={[]}
        trustEntries={[]}
        onClose={() => undefined}
        onTrustChange={() => undefined}
        onRename={() => undefined}
        onMove={() => undefined}
      />,
    );
    expect(screen.getByText(/Sub-group of/i)).toBeTruthy();
    expect(screen.getByText('Parent A')).toBeTruthy();
  });

  it('opens the Move-to picker and fires onMove with the chosen parent id', () => {
    const onMove = vi.fn();
    render(
      <WorkstreamDetailPanel
        workstreamLabel="Sub group"
        workstream={{ bac_id: 'ws_sub', title: 'Sub group', parentId: 'ws_root_a' }}
        workstreams={TREE}
        linkedNotes={[]}
        trustEntries={[]}
        onClose={() => undefined}
        onTrustChange={() => undefined}
        onRename={() => undefined}
        onMove={onMove}
      />,
    );
    fireEvent.click(screen.getByText('Move to…'));
    // Parent A is the current parent → filtered out of the picker.
    // Parent B is the only candidate.
    fireEvent.click(screen.getByText('Parent B'));
    expect(onMove).toHaveBeenCalledWith('ws_root_b');
  });

  it('detaches to top-level when the "Top-level" row is picked', () => {
    const onMove = vi.fn();
    render(
      <WorkstreamDetailPanel
        workstreamLabel="Sub group"
        workstream={{ bac_id: 'ws_sub', title: 'Sub group', parentId: 'ws_root_a' }}
        workstreams={TREE}
        linkedNotes={[]}
        trustEntries={[]}
        onClose={() => undefined}
        onTrustChange={() => undefined}
        onRename={() => undefined}
        onMove={onMove}
      />,
    );
    fireEvent.click(screen.getByText('Move to…'));
    fireEvent.click(screen.getByText(/Top-level/i));
    expect(onMove).toHaveBeenCalledWith(null);
  });

  it('hides rename + Hierarchy section when the panel is in read-only mode', () => {
    render(
      <WorkstreamDetailPanel
        workstreamLabel="Inbox"
        linkedNotes={[]}
        trustEntries={[]}
        onClose={() => undefined}
        onTrustChange={() => undefined}
      />,
    );
    expect(screen.queryByText('Hierarchy')).toBeNull();
    // Title button has no editable affordance.
    const title = screen.getByText('Inbox').closest('button');
    expect((title as HTMLButtonElement).disabled).toBe(true);
  });
});
