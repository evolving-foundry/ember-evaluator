import type { Context } from "@deepseek-ai/cordis";
import { apply as benchmarks } from "./benchmarks/index.js";
import { apply as solvers } from "./solvers/index.js";
import { apply as schedulers } from "./schedulers/index.js";
import { apply as environments } from "./environments/index.js";
import { apply as verifiers } from "./verifiers/index.js";
import { apply as stores } from "./stores/index.js";
import { apply as metrics } from "./metrics/index.js";
import { apply as reporters } from "./reporters/index.js";

export const inject = ["evaluator"];
export async function apply(ctx: Context): Promise<void> {
  await benchmarks(ctx);
  solvers(ctx);
  schedulers(ctx);
  environments(ctx);
  verifiers(ctx);
  stores(ctx);
  metrics(ctx);
  reporters(ctx);
}
