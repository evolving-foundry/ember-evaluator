import type { Context } from "@deepseek-ai/cordis";
import { SimpleAgentSolver, parseSimpleAgentConfig } from "./simpleagent.js";
import { ChoiceLogprobsSolver, parseChoiceLogprobsConfig } from "./choice-logprobs.js";
import { AgentBundleSolver, agentBundleModel, parseAgentBundleConfig } from "./agentbundle.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { bindSolverService } from "../../core/contracts/plugin.js";
import { AgentXReplaySolver, parseAgentXReplayConfig } from "./agentx-replay.js";
import { KernelReplaySolver } from "./kernel-replay.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register("solver", "choice-logprobs", parseChoiceLogprobsConfig, (config, runtime) => {
    const { model, auth } = bindSolverService(runtime);
    return new ChoiceLogprobsSolver(config, model, auth, runtime.environmentName);
  });
  ctx.evaluator.register("solver", "kernel-replay", (value: unknown) => {
    const config = expectRecord(value, "kernel-replay");
    rejectUnknown(config, [], "kernel-replay");
    return {};
  }, () => new KernelReplaySolver());
  ctx.evaluator.register("solver", "agentx-replay", parseAgentXReplayConfig, (config, runtime) => new AgentXReplaySolver(config, runtime));
  ctx.evaluator.register(
    "solver",
    "agentbundle",
    parseAgentBundleConfig,
    (config, runtime) => {
      const bound = bindSolverService(runtime);
      const model = agentBundleModel(bound.model, config.maxTokens, runtime.solverService);
      const solver = new AgentBundleSolver(runtime.resolvePath(config.path), model, bound.auth, undefined, {
        environmentName: runtime.environmentName ?? "local",
        ...(config.dshhome === undefined ? {} : { dshhome: runtime.resolvePath(config.dshhome) }),
        ...(config.dshprofile === undefined ? {} : { dshprofile: config.dshprofile }),
        ...(config.hermeshome === undefined ? {} : { hermeshome: runtime.resolvePath(config.hermeshome) }),
        ...(config.jiuwenswarmTimeoutSeconds === undefined ? {} : { jiuwenswarmTimeoutSeconds: config.jiuwenswarmTimeoutSeconds }),
        ...(config.pi === undefined ? {} : { pi: config.pi }),
        ...(config.dify === undefined ? {} : { dify: {
          ...config.dify,
          ...(config.dify.registryPath === undefined ? {} : { registryPath: runtime.resolvePath(config.dify.registryPath) }),
        } }),
      }, runtime.network);
      ctx.effect(() => () => solver.dispose(), "AgentBundle staging lifecycle");
      return solver;
    },
  );
  ctx.evaluator.register(
    "solver",
    "simpleagent",
    parseSimpleAgentConfig,
    (config, runtime) => {
      const bound = bindSolverService(runtime);
      const solver = new SimpleAgentSolver(
        bound.model,
        bound.auth,
        config.bundle === undefined
          ? undefined
          : {
              path: runtime.resolvePath(config.bundle.path),
              ...(config.bundle.settings === undefined ? {} : { settings: config.bundle.settings }),
            },
        config.toolPolicy,
      );
      ctx.effect(() => () => solver.dispose(), "simpleagent staging lifecycle");
      return solver;
    },
  );
}
