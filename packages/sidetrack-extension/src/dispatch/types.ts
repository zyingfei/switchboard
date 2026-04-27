import type { ProviderId } from '../companion/model';

import type {
  DispatchTarget as UiDispatchTarget,
  PacketKind as UiPacketKind,
} from '../../entrypoints/sidepanel/components';

export type DispatchKind = 'research' | 'review' | 'coding' | 'note' | 'other';

export type DispatchTargetProvider =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'claude_code'
  | 'cursor'
  | 'other';

export type DispatchStatus = 'queued' | 'sent' | 'replied' | 'noted' | 'pending' | 'failed';

export type DispatchMode = 'paste' | 'auto-send';

export interface DispatchRedactionSummary {
  readonly matched: number;
  readonly categories: readonly string[];
}

export interface DispatchTarget {
  readonly provider: DispatchTargetProvider;
  readonly mode: DispatchMode;
}

export interface DispatchEventInput {
  readonly bac_id?: string;
  readonly kind: DispatchKind;
  readonly target: DispatchTarget;
  readonly sourceThreadId?: string;
  readonly workstreamId?: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt?: string;
  readonly redactionSummary?: DispatchRedactionSummary;
  readonly tokenEstimate?: number;
  readonly status?: DispatchStatus;
}

export interface DispatchEventRecord {
  readonly bac_id: string;
  readonly kind: DispatchKind;
  readonly target: DispatchTarget;
  readonly sourceThreadId?: string;
  readonly workstreamId?: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly redactionSummary: DispatchRedactionSummary;
  readonly tokenEstimate: number;
  readonly status: DispatchStatus;
}

export interface DispatchSubmitResult {
  readonly bac_id: string;
  readonly status: 'recorded';
  readonly warnings?: readonly string[];
  readonly tokenEstimate?: number;
  readonly redactionSummary?: DispatchRedactionSummary;
}

const PACKET_KIND_MAP: Record<UiPacketKind, DispatchKind> = {
  context_pack: 'note',
  research_packet: 'research',
  coding_agent_packet: 'coding',
  notebook_export: 'note',
};

const TARGET_MAP: Record<UiDispatchTarget, DispatchTargetProvider> = {
  gpt_pro: 'chatgpt',
  deep_research: 'chatgpt',
  claude: 'claude',
  gemini: 'gemini',
  codex: 'codex',
  claude_code: 'claude_code',
  cursor: 'cursor',
  notebook: 'other',
  markdown: 'other',
};

export const mapUiPacketKind = (kind: UiPacketKind): DispatchKind => PACKET_KIND_MAP[kind];

export const mapUiTarget = (target: UiDispatchTarget): DispatchTargetProvider => TARGET_MAP[target];

const REVERSE_PACKET_KIND: Record<DispatchKind, UiPacketKind> = {
  research: 'research_packet',
  review: 'context_pack',
  coding: 'coding_agent_packet',
  note: 'context_pack',
  other: 'context_pack',
};

const REVERSE_TARGET: Record<DispatchTargetProvider, UiDispatchTarget> = {
  chatgpt: 'gpt_pro',
  claude: 'claude',
  gemini: 'gemini',
  codex: 'codex',
  claude_code: 'claude_code',
  cursor: 'cursor',
  other: 'notebook',
};

export const dispatchKindToUiPacketKind = (kind: DispatchKind): UiPacketKind =>
  REVERSE_PACKET_KIND[kind];

export const dispatchProviderToUiTarget = (provider: DispatchTargetProvider): UiDispatchTarget =>
  REVERSE_TARGET[provider];

export const providerIdToDispatchProvider = (provider: ProviderId): DispatchTargetProvider => {
  switch (provider) {
    case 'chatgpt':
      return 'chatgpt';
    case 'claude':
      return 'claude';
    case 'gemini':
      return 'gemini';
    case 'unknown':
      return 'other';
  }
};
