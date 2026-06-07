import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolbarOverflowMenu } from '../../entrypoints/sidepanel/components/ToolbarOverflowMenu';

afterEach(() => {
  vi.restoreAllMocks();
});

const renderMenu = (overrides: Partial<Parameters<typeof ToolbarOverflowMenu>[0]> = {}) => {
  const onOpenHealth = vi.fn();
  const onDumpState = vi.fn();
  const onOpenDesignPreview = vi.fn();
  render(
    <ToolbarOverflowMenu
      onOpenHealth={onOpenHealth}
      onDumpState={onDumpState}
      onOpenDesignPreview={onOpenDesignPreview}
      dumpStatus="idle"
      {...overrides}
    />,
  );
  return { onOpenHealth, onDumpState, onOpenDesignPreview };
};

describe('ToolbarOverflowMenu', () => {
  it('keeps the diagnostic actions hidden until the kebab is opened', () => {
    renderMenu();
    expect(screen.queryByRole('menuitem', { name: 'Capture health' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toolbar-overflow'));

    expect(screen.getByRole('menuitem', { name: 'Capture health' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Dump panel state/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Design preview' })).toBeInTheDocument();
  });

  it('fires the matching callback and closes the menu when an item is picked', () => {
    const { onOpenHealth } = renderMenu();
    fireEvent.click(screen.getByTestId('toolbar-overflow'));

    fireEvent.click(screen.getByRole('menuitem', { name: 'Capture health' }));

    expect(onOpenHealth).toHaveBeenCalledTimes(1);
    // Picking an item dismisses the popover.
    expect(screen.queryByRole('menuitem', { name: 'Capture health' })).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('toolbar-overflow'));
    expect(screen.getByRole('menuitem', { name: 'Design preview' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menuitem', { name: 'Design preview' })).not.toBeInTheDocument();
  });

  it('reflects a completed dump on the trigger and the Dump row', () => {
    renderMenu({ dumpStatus: 'dumped' });
    fireEvent.click(screen.getByTestId('toolbar-overflow'));
    // The ✓ marker is appended to the Dump row label when a dump landed.
    expect(screen.getByRole('menuitem', { name: /Dump panel state ✓/ })).toBeInTheDocument();
  });
});
