import type { Context } from "@deepseek-ai/cordis";
import { HarborShellVerifier, parseShellVerifierConfig } from "./shell.js";
import { HarborPythonVerifier, parsePythonVerifierConfig } from "./python/index.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register("verifier", "harbor-shell", parseShellVerifierConfig, () => new HarborShellVerifier());
  ctx.evaluator.register("verifier", "harbor-python", parsePythonVerifierConfig, (config, runtime) => new HarborPythonVerifier(config, runtime),
    { nodeLocal: { dockerExecutable: "docker" } });
}
