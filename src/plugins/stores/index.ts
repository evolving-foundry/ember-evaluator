import type { Context } from "@deepseek-ai/cordis";
import { LocalRunStore } from "./local.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register(
    "store",
    "local",
    (value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid local store config");
      const config = value as Record<string, unknown>;
      if (Object.keys(config).some(key => key !== "runIndexDirectory") ||
        (config.runIndexDirectory !== undefined && (typeof config.runIndexDirectory !== "string" || !config.runIndexDirectory.trim())))
        throw new TypeError("local store accepts only optional runIndexDirectory; use output.directory for the root");
      return config.runIndexDirectory === undefined ? {} : { runIndexDirectory: String(config.runIndexDirectory) };
    },
    (config, runtime) => {
      const store = new LocalRunStore(config.runIndexDirectory === undefined ? undefined : runtime.resolvePath(config.runIndexDirectory));
      ctx.effect(() => () => store.close(), "local store writer lock");
      return store;
    },
  );
}
