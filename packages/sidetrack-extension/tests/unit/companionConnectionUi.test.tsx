import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  SettingsPanel,
  Wizard,
} from '../../entrypoints/sidepanel/components';

const STUB_PROPS = {
  settings: null,
  localPreferences: { autoTrack: false, vaultPath: '', notifyOnQueueComplete: false },
  companionConfigured: true,
  archivedThreads: [] as const,
  workstreams: [] as const,
  screenShareMode: false,
  busy: false,
  onClose: () => undefined,
  onSave: () => undefined,
  onSaveLocalPreferences: () => undefined,
  onRestoreThread: () => undefined,
  onDeleteThread: () => undefined,
  onBulkUpdateWorkstreamPrivacy: () => undefined,
  onToggleWorkstreamSensitive: () => undefined,
  onSetScreenShareMode: () => undefined,
};

describe('SettingsPanel — Companion connection section', () => {
  it('renders the port + bridge key inputs when onSaveCompanionConnection is provided', () => {
    render(
      <SettingsPanel
        {...STUB_PROPS}
        companionPort={27373}
        bridgeKey="seeded-key"
        onSaveCompanionConnection={() => undefined}
      />,
    );
    expect(screen.getByText('Companion connection')).toBeTruthy();
    expect((screen.getByLabelText('Companion port') as HTMLInputElement).value).toBe('27373');
    expect((screen.getByLabelText('Bridge key') as HTMLInputElement).value).toBe('seeded-key');
  });

  it('omits the section entirely in legacy embeddings (no save callback)', () => {
    render(<SettingsPanel {...STUB_PROPS} companionPort={17_373} bridgeKey="x" />);
    expect(screen.queryByText('Companion connection')).toBeNull();
  });

  it('fires onSaveCompanionConnection with the edited port + key when Save connection clicked', () => {
    const onSave = vi.fn();
    render(
      <SettingsPanel
        {...STUB_PROPS}
        companionPort={17_373}
        bridgeKey=""
        onSaveCompanionConnection={onSave}
      />,
    );
    const portInput = screen.getByLabelText('Companion port') as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: '27373' } });
    const keyInput = screen.getByLabelText('Bridge key') as HTMLInputElement;
    fireEvent.change(keyInput, {
      target: { value: '2BMaA0j4160UYast-YXn2Fq9TlkqPi5W0iaQOj3_vcQ' },
    });
    fireEvent.click(screen.getByText('Save connection'));
    expect(onSave).toHaveBeenCalledWith({
      port: 27373,
      bridgeKey: '2BMaA0j4160UYast-YXn2Fq9TlkqPi5W0iaQOj3_vcQ',
    });
  });

  it('disables Save connection when port + key are unchanged', () => {
    render(
      <SettingsPanel
        {...STUB_PROPS}
        companionPort={27_373}
        bridgeKey="seeded-key"
        onSaveCompanionConnection={() => undefined}
      />,
    );
    const save = screen.getByText('Save connection') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe('Wizard CompanionStep — Advanced port input', () => {
  it('exposes a port input behind an Advanced toggle and fires onPortChange on commit', () => {
    const onPortChange = vi.fn();
    render(
      <Wizard
        onClose={() => undefined}
        onFinish={() => undefined}
        port={17_373}
        bridgeKey=""
        vaultPath="~/Documents/Sidetrack-vault"
        onPortChange={onPortChange}
      />,
    );
    // Step through Welcome → Vault → Companion.
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    // The Advanced toggle is collapsed by default for the canonical
    // 17373 case. Open it.
    const toggle = screen.getByText(/Advanced — port/i);
    fireEvent.click(toggle);
    const portInput = screen.getByLabelText('Companion port') as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: '27373' } });
    fireEvent.blur(portInput);
    expect(onPortChange).toHaveBeenCalledWith(27_373);
  });

  it('starts open when the supplied port is non-default', () => {
    render(
      <Wizard
        onClose={() => undefined}
        onFinish={() => undefined}
        port={27_373}
        bridgeKey=""
        vaultPath=""
        onPortChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    // Auto-open: the input is rendered immediately, no need to click toggle.
    expect((screen.getByLabelText('Companion port') as HTMLInputElement).value).toBe('27373');
  });
});
