// Re-exports for the M1+M2 UX skeletons.
//
// These components are visual scaffolds with stub data and minimal logic.
// They demonstrate the design language and interaction patterns end-to-end
// so that Codex (or a follow-up build pass) can wire them into the runtime
// state machine without re-deriving structure or visual tokens.
//
// Source-of-truth for visual structure:
//   design/mockup-stage/project/{panel.jsx, modals.jsx, styles.css}
//
// Status:
//   ✅ M2 dispatch surfaces (Mock 5, 6, 7, 8, 12, 13b, 14)
//   ✅ M1 polish (Mock 3, 4, 10, 13a)
//   ⏳ Wired into App.tsx — preview entry only for now (preview.html);
//      runtime wiring is Codex's M1.5 / M2 task

export { Icons, type IconName } from './icons';
export { Modal } from './Modal';

// M2 surfaces
export { PacketComposer } from './PacketComposer';
export type {
  ComposedPacket,
  PacketComposerProps,
  PacketComposerScope,
  PacketKind,
  ResearchTemplate,
  DispatchTarget,
} from './PacketComposer';

export { DispatchConfirm } from './DispatchConfirm';
export type { DispatchConfirmProps } from './DispatchConfirm';

export { ReviewComposer } from './ReviewComposer';
export type { ReviewComposerProps, ReviewVerdict, ReviewSpan } from './ReviewComposer';

export { Wizard } from './Wizard';
export type { WizardProps, WizardStep } from './Wizard';

export { CodingAttach } from './CodingAttach';
export type { CodingAttachProps, CodingTool } from './CodingAttach';

export { Annotation } from './Annotation';
export type { AnnotationProps } from './Annotation';

export { RecentDispatches } from './RecentDispatches';
export type { RecentDispatchesProps, DispatchEvent, DispatchStatus } from './RecentDispatches';

export { SendToDropdown } from './SendToDropdown';
export type { SendToDropdownProps, SendToTarget } from './SendToDropdown';

// M1 polish
export { TabRecovery } from './TabRecovery';
export type { TabRecoveryProps, TabSnapshot, RestoreStrategy } from './TabRecovery';

export { MoveToPicker } from './MoveToPicker';
export type { MoveToPickerProps, WorkstreamOption } from './MoveToPicker';

export { SystemBanner, SystemBannersStack } from './SystemBanners';
export type { SystemBannerProps, SystemBannersStackProps, SystemState } from './SystemBanners';

export { InboundCard } from './InboundCard';
export type { InboundCardProps, InboundReminder } from './InboundCard';

export { SettingsPanel } from './SettingsPanel';
export type { SettingsPanelProps, SettingsValue } from './SettingsPanel';
