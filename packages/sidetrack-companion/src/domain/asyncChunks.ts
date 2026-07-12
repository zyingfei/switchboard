/** Map items through an async fn in fixed-size chunks: each chunk's
 *  calls run CONCURRENTLY (Promise.all), chunks run sequentially so
 *  fd / connection usage stays bounded.
 *
 *  Why this exists: vault file passes (stat sweeps, record reads)
 *  written as sequential await-per-item loops re-queue behind a busy
 *  event loop on EVERY item — a ~1800-file stat pass measured 36.9 s
 *  under boot catch-up contention, vs ~180 ms chunked. Use this for
 *  pure-I/O passes; loops that interleave sync work (e.g. SQLite
 *  upserts) between chunks still need their own explicit
 *  yield-to-event-loop structure. */
export const mapInChunks = async <T, R>(
  items: readonly T[],
  chunkSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
};
