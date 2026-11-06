import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityListener } from "../../core/contracts/activity.js";
import type { Benchmark } from "../../core/contracts/benchmark.js";
import { safeLiveText } from "../../core/progress/live-progress.js";

const scope = new AsyncLocalStorage<ActivityListener | undefined>();

/** Each source invocation owns its observer, including concurrent preparations. */
export function withDatasetActivity<T>(activity: ActivityListener | undefined, work: () => T): T {
  return scope.run(activity, work);
}

export function datasetActivity(line: string): void {
  scope.getStore()?.({ lines: [safeLiveText(line)] });
}

export function datasetActivityListener(): ActivityListener | undefined { return scope.getStore(); }

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function manifestActivity(): (count: number) => void {
  let last = -Infinity;
  return count => {
    if (performance.now() - last >= 200) {
      datasetActivity(`Validated ${count} source files`);
      last = performance.now();
    }
  };
}

type DatasetBenchmark = Pick<Benchmark, "resolveSource" | "enumerate" | "prepare">;

export function observeDatasetSource(source: DatasetBenchmark): DatasetBenchmark {
  return {
    resolveSource: (previous, signal, activity) => withDatasetActivity(activity, () => source.resolveSource(previous, signal, activity)),
    prepare: (ref, lock, signal, activity) => withDatasetActivity(activity, () => source.prepare(ref, lock, signal, activity)),
    async *enumerate(lock, signal, activity) {
      const iterator = source.enumerate(lock, signal, activity)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const item = await withDatasetActivity(activity, () => iterator.next());
          if (item.done) return;
          yield item.value;
        }
      } finally { await withDatasetActivity(activity, () => iterator.return?.()); }
    },
  };
}
