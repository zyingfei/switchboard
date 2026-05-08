import type { BufferedEvent, EventBuffer } from './in-memory-event-buffer';

export const MAX_BATCH_SIZE = 100;
export const MAX_BATCH_LATENCY_MS = 1_000;
export const FLUSH_ALARM = 'sidetrack.classf.flush';
export const FLUSH_ALARM_PERIOD_MINUTES = 1;

export interface FlushScheduler {
  append(event: BufferedEvent): Promise<void>;
  flushNow(): Promise<BufferedEvent[]>;
  start(): Promise<void>;
}

export const createFlushScheduler = (buffer: EventBuffer): FlushScheduler => {
  let pending: BufferedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushPendingToStore = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await buffer.appendMany(batch);
  };

  return {
    async append(event) {
      pending.push(event);
      if (pending.length >= MAX_BATCH_SIZE) {
        await flushPendingToStore();
        return;
      }
      if (timer === null) {
        timer = setTimeout(() => {
          void flushPendingToStore();
        }, MAX_BATCH_LATENCY_MS);
      }
    },
    async flushNow() {
      await flushPendingToStore();
      return buffer.peek(MAX_BATCH_SIZE);
    },
    async start() {
      await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_ALARM_PERIOD_MINUTES });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === FLUSH_ALARM) {
          void flushPendingToStore();
        }
      });
    },
  };
};
