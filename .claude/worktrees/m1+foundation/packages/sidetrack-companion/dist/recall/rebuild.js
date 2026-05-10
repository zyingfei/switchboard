import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embed, MODEL_ID } from './embedder.js';
import { upsertEntries } from './indexFile.js';
const isCaptureEventRecord = (value) => typeof value === 'object' &&
    value !== null &&
    'turns' in value &&
    Array.isArray(value.turns);
const eventFiles = async (eventLogPath) => {
    if (eventLogPath.endsWith('.jsonl')) {
        return [eventLogPath];
    }
    const names = await readdir(eventLogPath).catch(() => []);
    return names
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(eventLogPath, name));
};
// Cap the number of texts per embedder call. The embedder allocates
// a tensor of shape [batchSize, dim, …] plus per-token activations,
// so a single 500-item batch peaks well past 1GB on a base-MiniLM
// pipeline and macOS will SIGKILL the process. 16 keeps peak under
// ~250MB on this model and still amortizes the per-call overhead.
const EMBED_BATCH_SIZE = 16;
// Tighter cap when called with explicit `EMBED_TEXT_CHARS` to keep
// individual turns from blowing up the per-batch tensor (a single
// 50KB turn becomes ~12K tokens). The model's max sequence length
// is 256, so anything past ~1500 chars gets truncated anyway —
// trimming up front saves the tokenizer + tensor cost.
const EMBED_TEXT_CHARS = 4000;
export const rebuildFromEventLog = async (vaultRoot, eventLogPath, options = {}) => {
    const rawItems = [];
    for (const file of await eventFiles(eventLogPath)) {
        const raw = await readFile(file, 'utf8').catch(() => '');
        for (const line of raw.split('\n')) {
            if (line.trim().length === 0) {
                continue;
            }
            try {
                const parsed = JSON.parse(line);
                if (!isCaptureEventRecord(parsed)) {
                    continue;
                }
                const threadId = parsed.bac_id ?? parsed.threadId ?? parsed.threadUrl;
                if (threadId === undefined || parsed.capturedAt === undefined) {
                    continue;
                }
                for (const turn of parsed.turns) {
                    if (typeof turn.text !== 'string' || turn.text.trim().length === 0) {
                        continue;
                    }
                    rawItems.push({
                        id: `${threadId}:${String(turn.ordinal ?? rawItems.length)}`,
                        threadId,
                        capturedAt: turn.capturedAt ?? parsed.capturedAt,
                        text: turn.text.slice(0, EMBED_TEXT_CHARS),
                    });
                }
            }
            catch {
                // Ignore malformed event-log lines; the source of truth remains append-only.
            }
        }
    }
    const total = rawItems.length;
    const entries = [];
    for (let offset = 0; offset < total; offset += EMBED_BATCH_SIZE) {
        const batch = rawItems.slice(offset, offset + EMBED_BATCH_SIZE);
        const vectors = await embed(batch.map((item) => item.text));
        for (let index = 0; index < batch.length; index += 1) {
            const item = batch[index];
            const embedding = vectors[index];
            if (item === undefined || embedding === undefined)
                continue;
            entries.push({
                id: item.id,
                threadId: item.threadId,
                capturedAt: item.capturedAt,
                embedding,
            });
        }
        options.onProgress?.(entries.length, total);
        // Yield to the event loop so the HTTP server can respond to
        // /v1/system/health (and any other request) between batches.
        // Without this the rebuild monopolizes the loop and every other
        // endpoint times out — which is what made the rebuild look
        // hung even when it was making progress.
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
    await upsertEntries(join(vaultRoot, '_BAC', 'recall', 'index.bin'), entries, MODEL_ID);
    return { indexed: entries.length };
};
//# sourceMappingURL=rebuild.js.map