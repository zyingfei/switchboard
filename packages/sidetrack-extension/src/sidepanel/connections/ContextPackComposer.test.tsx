import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import fullFixture from './__fixtures__/context-pack-full.json';
import { ContextPackComposer } from './ContextPackComposer';
import { buildContextPack, type ContextPackInput } from './contextPack';

describe('ContextPackComposer', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('composes Markdown from the client fixture', async () => {
    render(
      <ContextPackComposer
        workstreamId="workstream:a"
        loadInput={async () => fullFixture as ContextPackInput}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Compose Context Pack'));
    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(
        buildContextPack(fullFixture as ContextPackInput),
      );
    });
  });

  it('copies Markdown to the clipboard', async () => {
    render(
      <ContextPackComposer
        workstreamId="workstream:a"
        loadInput={async () => fullFixture as ContextPackInput}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Compose Context Pack'));
    await waitFor(() => {
      expect(screen.queryByTestId('context-pack-copy')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('context-pack-copy'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      buildContextPack(fullFixture as ContextPackInput),
    );
  });
});
