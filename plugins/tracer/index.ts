import type { Context } from "@deepseek-ai/cordis";
import type { RunStore } from "ember-evaluator";
import { TracerClient } from "./client.js";
import { parseTracerOptions, parseTracerConfig, resolveTracerConfig } from "./config.js";
import { TracerStore } from "./store.js";

export { TracerClient } from "./client.js";
export { parseTracerConfig, resolveTracerConfig } from "./config.js";
export type { TracerConfig } from "./config.js";
export { TracerService } from "./service.js";
export type { TracerHealth } from "./service.js";
export { TracerStore } from "./store.js";

export { registerCli } from "./cli-register.js";

export const inject = ["evaluator"];

type WarningLevel = "info" | "warning";

/** Standalone runs have no reporter, so fall back to a clearly marked stderr line. */
function notifier(sink: ((message: string, level?: WarningLevel) => void) | undefined):
(message: string, level?: WarningLevel) => void {
  const emit: (message: string, level?: WarningLevel) => void =
    sink ?? ((message: string) => process.stderr.write(`${message}\n`));
  const tag = process.env.NO_COLOR === undefined ? "\x1b[36m[tracer]\x1b[0m" : "[tracer]";
  return (message, level) => emit(`${tag} ${message}`, level);
}

/** Registers `store-decorator: tracer`, mirroring attempts into the Collector without replacing the store. */
export function apply(ctx: Context): void {
  ctx.evaluator.registerStoreDecorator(
    "trajectory-mirror",
    parseTracerOptions,
    async (config, runtime) => {
      const warn = notifier(runtime.onWarning);
      const client = new TracerClient(resolveTracerConfig(parseTracerConfig(config), runtime.resolvePath), warn, runtime.signal);
      return (inner: RunStore) => {
        const store = new TracerStore(inner, client, warn);
        ctx.effect(() => () => store.dispose(), "tracer tails");
        return store;
      };
    },
  );
}
