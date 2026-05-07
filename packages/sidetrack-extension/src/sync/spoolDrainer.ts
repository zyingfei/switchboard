// Sync Contract v1 / Class F — spool drainer.
//
// Walks spooled entries and uploads each to the companion's
// importPeerEvent surface (or per-surface emit endpoint when one
// exists). Idempotent on edgeDot — re-runs are safe.
//
// On success: transition to `companion-imported` then remove from
// the spool (the entry's content lives durably in the companion's
// event log; keeping it in chrome.storage would just bloat).
//
// On companion-unreachable: leave the entry as `spooled`. Next
// reconnect triggers another drain pass.
//
// On other errors: leave the entry as `spooled` with an error
// message recorded for the side panel banner (gate L3-G3).

import {
  readSpool,
  spoolRemove,
  spoolTransition,
  type SpoolEntry,
} from './spool';

export interface CompanionImportPort {
  // Send an edge-origin event to the companion. Implementations
  // wrap fetch() against /v1/events or a future
  // /v1/sync/import-edge endpoint. Idempotent on the event's
  // edgeDot (handled by companion-side importPeerEvent).
  readonly importEvent: (entry: SpoolEntry) => Promise<{ ok: boolean; reason?: string }>;
}

export interface DrainResult {
  readonly uploaded: number;
  readonly remaining: number;
  readonly errors: number;
}

export const drainSpoolToCompanion = async (
  surface: string,
  port: CompanionImportPort,
): Promise<DrainResult> => {
  const items = await readSpool(surface);
  let uploaded = 0;
  let errors = 0;
  for (const entry of items) {
    if (entry.state !== 'spooled' && entry.state !== 'pending-send') {
      // Already terminal (imported / failed / dropped) — skip.
      continue;
    }
    try {
      const result = await port.importEvent(entry);
      if (result.ok) {
        // Mark imported then remove. The intermediate transition
        // is observable in metrics for a brief moment; that's the
        // documented state machine.
        await spoolTransition(surface, entry.edgeDot, 'companion-imported');
        await spoolRemove(surface, entry.edgeDot);
        uploaded += 1;
      } else {
        errors += 1;
        await spoolTransition(
          surface,
          entry.edgeDot,
          'spooled',
          result.reason ?? 'companion-import-rejected',
        );
      }
    } catch (err) {
      errors += 1;
      await spoolTransition(
        surface,
        entry.edgeDot,
        'spooled',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const remainingItems = await readSpool(surface);
  return {
    uploaded,
    remaining: remainingItems.length,
    errors,
  };
};
