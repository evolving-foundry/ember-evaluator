/** Keep preparation bounded and drain every started operation before returning. */
export async function runPreparationQueue<T>(
  items: readonly T[], concurrency: number, signal: AbortSignal,
  prepare: (item: T, index: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new TypeError("Preparation concurrency must be a positive integer");
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const entries = items.entries();
  const worker = async () => {
    for (;;) {
      combined.throwIfAborted();
      const entry = entries.next();
      if (entry.done) return;
      const [index, item] = entry.value;
      try { await prepare(item, index, combined); }
      catch (error) { controller.abort(error); throw error; }
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  combined.throwIfAborted();
}
