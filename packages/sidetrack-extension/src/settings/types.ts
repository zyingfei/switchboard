import type { DispatchKind, DispatchTargetProvider } from '../dispatch/types';

export interface ProviderOptIn {
  readonly chatgpt: boolean;
  readonly claude: boolean;
  readonly gemini: boolean;
}

export interface SettingsDocument {
  readonly autoSendOptIn: ProviderOptIn;
  readonly defaultPacketKind: DispatchKind;
  readonly defaultDispatchTarget: DispatchTargetProvider;
  readonly screenShareSafeMode: boolean;
  readonly revision: string;
}

export interface SettingsPatch {
  readonly revision: string;
  readonly autoSendOptIn?: Partial<ProviderOptIn>;
  readonly defaultPacketKind?: DispatchKind;
  readonly defaultDispatchTarget?: DispatchTargetProvider;
  readonly screenShareSafeMode?: boolean;
}

export const isProviderWithOptIn = (
  provider: DispatchTargetProvider,
): provider is keyof ProviderOptIn =>
  provider === 'chatgpt' || provider === 'claude' || provider === 'gemini';
