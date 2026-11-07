import type { Context } from "@deepseek-ai/cordis";
import { LocalScheduler } from "./local/scheduler.js";
import { RayScheduler } from "./ray/scheduler.js";
import { parseRayConfig } from "../../config/ray.js";
import { DEFAULT_LOCAL_CONCURRENCY } from "../../config/defaults.js";
import { expectRecord, rejectUnknown, expectPositiveInteger } from "../../core/validation/input.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register(
    "scheduler",
    "ray",
    parseRayConfig,
    (config, runtime) => {
      const scheduler = new RayScheduler(config, runtime, (role, name) => ctx.evaluator.configTransport(role, name));
      ctx.effect(() => () => scheduler.close(), "Ray scheduler lifecycle");
      return scheduler;
    },
  );
  ctx.evaluator.register(
    "scheduler",
    "local",
    (value: unknown) => {
      const config = expectRecord(value, "local scheduler");
      rejectUnknown(config, ["concurrency"], "local scheduler");
      return { concurrency: expectPositiveInteger(config.concurrency ?? DEFAULT_LOCAL_CONCURRENCY, "concurrency") };
    },
    config => new LocalScheduler(config.concurrency),
  );
}
