import { join } from 'node:path';

export const parseDateStamp = (at: string | Date): string =>
  (at instanceof Date ? at.toISOString() : at).slice(0, 10);

export const inboxRootFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'inbox');

export const inboxDirFor = (vaultRoot: string, collectorId: string): string =>
  join(inboxRootFor(vaultRoot), collectorId);

export const inboxFileFor = (
  vaultRoot: string,
  collectorId: string,
  dateIso: string | Date,
): string => join(inboxDirFor(vaultRoot, collectorId), `${parseDateStamp(dateIso)}.jsonl`);

export const inboxArchiveDirFor = (vaultRoot: string, collectorId: string): string =>
  join(inboxDirFor(vaultRoot, collectorId), 'archive');

export const bookmarkPathFor = (vaultRoot: string, collectorId: string): string =>
  join(inboxDirFor(vaultRoot, collectorId), '.bookmark.json');

export const manifestRootFor = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'collectors');

export const manifestDirFor = (vaultRoot: string, collectorId: string): string =>
  join(manifestRootFor(vaultRoot), collectorId);

export const manifestPathFor = (vaultRoot: string, collectorId: string): string =>
  join(manifestDirFor(vaultRoot, collectorId), 'collector.toml');

export const quarantineRootFor = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'audit', 'quarantine');

export const quarantineDirFor = (vaultRoot: string, dateIso: string | Date): string =>
  join(quarantineRootFor(vaultRoot), parseDateStamp(dateIso));

export const quarantineFileFor = (
  vaultRoot: string,
  collectorId: string,
  dateIso: string | Date,
): string => join(quarantineDirFor(vaultRoot, dateIso), `${collectorId}.jsonl`);

export const validCollectorId = (s: string): boolean =>
  s.length >= 3 && s.length <= 64 && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(s);
