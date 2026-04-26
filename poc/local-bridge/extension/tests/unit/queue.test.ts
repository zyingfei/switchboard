import { buildSyntheticEvent } from '../../src/shared/messages';
import { drainQueue, enqueueCapture, readDroppedCount, readQueue } from '../../src/companion/queue';

describe('chrome.storage local capture queue', () => {
  it('replays queued captures in chronological order', async () => {
    const first = buildSyntheticEvent(1, 'manual');
    const second = buildSyntheticEvent(2, 'manual');
    await enqueueCapture(first);
    await enqueueCapture(second);
    const sent: number[] = [];
    const result = await drainQueue(async (event) => {
      sent.push(event.sequenceNumber);
    });
    expect(sent).toEqual([1, 2]);
    expect(result).toEqual({ sent: 2, remaining: 0 });
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('keeps unsent captures when replay fails', async () => {
    await enqueueCapture(buildSyntheticEvent(1, 'manual'));
    await enqueueCapture(buildSyntheticEvent(2, 'manual'));
    const result = await drainQueue(async (event) => {
      if (event.sequenceNumber === 2) {
        throw new Error('offline');
      }
    });
    expect(result).toEqual({ sent: 1, remaining: 1 });
    expect((await readQueue()).map((item) => item.event.sequenceNumber)).toEqual([2]);
  });

  it('caps the queue with oldest eviction', async () => {
    await enqueueCapture(buildSyntheticEvent(1, 'manual'), 2);
    await enqueueCapture(buildSyntheticEvent(2, 'manual'), 2);
    await enqueueCapture(buildSyntheticEvent(3, 'manual'), 2);
    expect((await readQueue()).map((item) => item.event.sequenceNumber)).toEqual([2, 3]);
    expect(await readDroppedCount()).toBe(1);
  });
});
