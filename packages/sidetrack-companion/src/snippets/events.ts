export const SELECTION_COPIED = 'selection.copied' as const;
export const SELECTION_PASTED = 'selection.pasted' as const;

export type SelectionEventType = typeof SELECTION_COPIED | typeof SELECTION_PASTED;

export interface SelectionCopiedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly selectionHash: string;
  readonly simhash64: string;
  readonly charCount: number;
  readonly lineCount: number;
  readonly contentKindHint: 'code-block' | 'prose' | 'url' | 'mixed';
  readonly rawTextStored: false;
}

export interface SelectionPastedPayload {
  readonly payloadVersion: 1;
  readonly destinationKind: 'thread' | 'dispatch' | 'search' | 'note' | 'capture';
  readonly destinationId: string;
  readonly selectionHash: string;
  readonly simhash64: string;
  readonly charCount: number;
  readonly rawTextStored: false;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasHashFields = (value: Record<string, unknown>): boolean =>
  value['payloadVersion'] === 1 &&
  value['rawTextStored'] === false &&
  typeof value['selectionHash'] === 'string' &&
  value['selectionHash'].length > 0 &&
  typeof value['simhash64'] === 'string' &&
  value['simhash64'].length > 0 &&
  typeof value['charCount'] === 'number' &&
  value['charCount'] >= 0 &&
  value['dimensions'] === undefined;

export const isSelectionCopiedPayload = (value: unknown): value is SelectionCopiedPayload =>
  isRecord(value) &&
  hasHashFields(value) &&
  typeof value['visitId'] === 'string' &&
  value['visitId'].length > 0 &&
  typeof value['lineCount'] === 'number' &&
  value['lineCount'] >= 0 &&
  (value['contentKindHint'] === 'code-block' ||
    value['contentKindHint'] === 'prose' ||
    value['contentKindHint'] === 'url' ||
    value['contentKindHint'] === 'mixed');

export const isSelectionPastedPayload = (value: unknown): value is SelectionPastedPayload =>
  isRecord(value) &&
  hasHashFields(value) &&
  typeof value['destinationId'] === 'string' &&
  value['destinationId'].length > 0 &&
  (value['destinationKind'] === 'thread' ||
    value['destinationKind'] === 'dispatch' ||
    value['destinationKind'] === 'search' ||
    value['destinationKind'] === 'note' ||
    value['destinationKind'] === 'capture');
