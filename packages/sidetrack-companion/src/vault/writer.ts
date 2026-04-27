import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createBacId, createRevision } from '../domain/ids.js';
import type {
  CaptureEventInput,
  QueueCreateInput,
  ReminderCreateInput,
  ThreadUpsertInput,
  WorkstreamCreateInput,
  WorkstreamUpdateInput,
} from '../http/schemas.js';

export interface MutationResult {
  readonly bac_id: string;
  readonly revision: string;
}

export interface AuditEvent {
  readonly requestId: string;
  readonly route: string;
  readonly outcome: 'success' | 'failure';
  readonly bac_id?: string;
  readonly timestamp: string;
}

export interface VaultWriter {
  readonly status: () => Promise<'connected' | 'unreachable'>;
  readonly writeCaptureEvent: (
    input: CaptureEventInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly upsertThread: (input: ThreadUpsertInput, requestId: string) => Promise<MutationResult>;
  readonly createWorkstream: (
    input: WorkstreamCreateInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly updateWorkstream: (
    workstreamId: string,
    input: WorkstreamUpdateInput,
    requestId: string,
  ) => Promise<MutationResult>;
  readonly createQueueItem: (input: QueueCreateInput, requestId: string) => Promise<MutationResult>;
  readonly createReminder: (
    input: ReminderCreateInput,
    requestId: string,
  ) => Promise<MutationResult>;
}

const dateStamp = (value: Date): string => value.toISOString().slice(0, 10);

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const appendJsonLine = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
};

const readJsonRecord = async (path: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object at ${path}`);
  }
  return parsed as Record<string, unknown>;
};

export const createVaultWriter = (vaultPath: string): VaultWriter => {
  const bacRoot = join(vaultPath, '_BAC');

  const ensureVaultPresent = async (): Promise<void> => {
    try {
      await access(vaultPath);
    } catch {
      throw new Error('Vault path is unavailable.');
    }
  };

  const audit = async (event: AuditEvent): Promise<void> => {
    await appendJsonLine(
      join(bacRoot, 'audit', `${dateStamp(new Date(event.timestamp))}.jsonl`),
      event,
    );
  };

  return {
    async status() {
      try {
        await access(vaultPath);
        return 'connected';
      } catch {
        return 'unreachable';
      }
    },

    async writeCaptureEvent(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const event = { ...input, bac_id, revision, requestId, receivedAt: timestamp };

      await appendJsonLine(
        join(bacRoot, 'events', `${dateStamp(new Date(input.capturedAt))}.jsonl`),
        event,
      );
      await audit({ requestId, route: 'appendEvent', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async upsertThread(input, requestId) {
      await ensureVaultPresent();
      const bac_id = input.bac_id ?? createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const thread = {
        ...input,
        bac_id,
        revision,
        updatedAt: timestamp,
        tags: input.tags ?? [],
        status: input.status ?? 'tracked',
      };

      await writeJson(join(bacRoot, 'threads', `${bac_id}.json`), thread);
      await audit({ requestId, route: 'upsertThread', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async createWorkstream(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const workstream = {
        ...input,
        bac_id,
        revision,
        children: [],
        checklist: [],
        tags: input.tags ?? [],
        privacy: input.privacy ?? 'private',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await writeJson(join(bacRoot, 'workstreams', `${bac_id}.json`), workstream);
      await audit({ requestId, route: 'createWorkstream', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async updateWorkstream(workstreamId, input, requestId) {
      await ensureVaultPresent();
      const path = join(bacRoot, 'workstreams', `${workstreamId}.json`);
      const existing = await readJsonRecord(path);
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        ...input,
        bac_id: workstreamId,
        revision,
        updatedAt: timestamp,
      };

      await writeJson(path, updated);
      await audit({
        requestId,
        route: 'updateWorkstream',
        outcome: 'success',
        bac_id: workstreamId,
        timestamp,
      });
      return { bac_id: workstreamId, revision };
    },

    async createQueueItem(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const queueItem = {
        ...input,
        bac_id,
        revision,
        status: input.status ?? 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await writeJson(join(bacRoot, 'queue', `${bac_id}.json`), queueItem);
      await audit({ requestId, route: 'createQueueItem', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },

    async createReminder(input, requestId) {
      await ensureVaultPresent();
      const bac_id = createBacId();
      const revision = createRevision();
      const timestamp = new Date().toISOString();
      const reminder = {
        ...input,
        bac_id,
        revision,
        status: input.status ?? 'new',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await writeJson(join(bacRoot, 'reminders', `${bac_id}.json`), reminder);
      await audit({ requestId, route: 'createReminder', outcome: 'success', bac_id, timestamp });
      return { bac_id, revision };
    },
  };
};
