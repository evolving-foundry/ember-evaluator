import { checkedPath } from "../../../core/artifacts/artifacts.js";
import { expectRecord, expectNonEmptyString, rejectUnknown } from "../../../core/validation/input.js";
import { bindService, type PluginFactoryContext } from "../../../core/contracts/plugin.js";
import type { Verifier, VerificationTask, VerificationEvidence } from "../../../core/contracts/verifier.js";
import type { JsonValue } from "../../../core/contracts/task.js";
import type { EnvironmentSession } from "../../../core/contracts/environment.js";
import { preparePythonVerifier } from "./runtime/bridge.js";
import { createPythonVerifierImage } from "./runtime/image.js";
import { materializeVerifierImage, recoverVerifierContainers } from "../shared/container.js";
import type { VerificationRuntime } from "../../../core/contracts/verification-runtime.js";

export type PythonVerifierConfig = { importPath: string; dockerExecutable: string; requireService: boolean; runtimeImage?: string; serviceEnv: { baseUrl: string; key: string; model: string } };
export function parsePythonVerifierConfig(value: unknown): PythonVerifierConfig {
  const config = expectRecord(value, "harbor-python");
  rejectUnknown(config, ["importPath", "dockerExecutable", "requireService", "runtimeImage", "serviceEnv"], "harbor-python");
  const importPath = expectNonEmptyString(config.importPath ?? "workbuddy_bench.judge:CompositeVerifier", "verifier.importPath");
  if (!/^[\w.]+:[A-Za-z_]\w*$/u.test(importPath)) throw new TypeError("Invalid Python verifier importPath");
  if (config.requireService !== undefined && typeof config.requireService !== "boolean") throw new TypeError("Invalid requireService");
  const serviceEnv = expectRecord(config.serviceEnv ?? { baseUrl: "WORKBUDDY_VERIFIER_LLM_BASE_URL", key: "WORKBUDDY_VERIFIER_LLM_API_KEY", model: "WORKBUDDY_VERIFIER_LLM_MODEL" }, "verifier.serviceEnv");
  rejectUnknown(serviceEnv, ["baseUrl", "key", "model"], "verifier.serviceEnv");
  for (const key of ["baseUrl", "key", "model"]) if (typeof serviceEnv[key] !== "string" || !/^[A-Za-z_]\w*$/u.test(serviceEnv[key])) throw new TypeError("Invalid verifier.serviceEnv variable");
  const runtimeImage = config.runtimeImage === undefined ? undefined : expectNonEmptyString(config.runtimeImage, "verifier.runtimeImage");
  if (runtimeImage !== undefined && !/@sha256:[a-f0-9]{64}$/u.test(runtimeImage)) throw new TypeError("verifier.runtimeImage must be pinned by sha256");
  return { importPath, serviceEnv: { baseUrl: String(serviceEnv.baseUrl), key: String(serviceEnv.key), model: String(serviceEnv.model) }, ...(runtimeImage === undefined ? {} : { runtimeImage }), dockerExecutable: expectNonEmptyString(config.dockerExecutable ?? "docker", "verifier.dockerExecutable"), requireService: config.requireService === true };
}
export class HarborPythonVerifier implements Verifier {
  private readonly image: (signal: AbortSignal) => Promise<string>;
  constructor(private readonly config: PythonVerifierConfig, private readonly factoryRuntime: PluginFactoryContext) {
    if (config.requireService && !factoryRuntime.verifierService) throw new TypeError("This verifier requires an explicit verifier.service binding");
    this.image = createPythonVerifierImage(config.dockerExecutable, undefined, factoryRuntime.network);
  }
  async prepare(task: VerificationTask, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted();
    await checkedPath(task.taskDir, "task.toml");
    return { ...task };
  }
  async verify(_value: JsonValue, _session: EnvironmentSession, _signal: AbortSignal): Promise<VerificationEvidence> {
    throw new Error("Python verifier must be opened through its runtime lifecycle");
  }
  readonly runtime: VerificationRuntime<JsonValue, VerificationEvidence> = {
    materialize: async (_descriptor, signal) => {
      const image = this.config.runtimeImage ?? await this.image(signal);
      return { image: await materializeVerifierImage(this.config.dockerExecutable, image, signal, this.factoryRuntime.network) };
    },
    recoverAttempts: (keys, signal) => recoverVerifierContainers(this.config.dockerExecutable, keys, signal),
    prepare: async (value, receipt, { key, signal }) => {
      const image = expectNonEmptyString(expectRecord(receipt, "verification runtime").image, "verification runtime image");
      const envelope = expectRecord(value, "verification");
      const descriptor = expectRecord(envelope.descriptor, "verification.descriptor");
      if (typeof descriptor.id !== "string" || typeof descriptor.taskDir !== "string" || typeof descriptor.datasetDir !== "string" ||
          typeof descriptor.workdir !== "string" || descriptor.timeoutSeconds !== undefined && (typeof descriptor.timeoutSeconds !== "number" || !Number.isFinite(descriptor.timeoutSeconds) || descriptor.timeoutSeconds <= 0)) throw new Error("Invalid Python verifier descriptor");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(expectRecord(envelope.env ?? {}, "verifier.env"))) {
        if (typeof value !== "string") throw new Error("Invalid verifier env");
        env[key] = value;
      }
      if (this.factoryRuntime.verifierService) {
        const binding = bindService(this.factoryRuntime, this.factoryRuntime.verifierService);
        if (!binding.model.endpoint) throw new Error("Verifier service requires a model endpoint");
        Object.assign(env, { [this.config.serviceEnv.baseUrl]: binding.model.endpoint,
          [this.config.serviceEnv.key]: binding.auth.value, [this.config.serviceEnv.model]: binding.model.name });
      }
      return preparePythonVerifier({ id: descriptor.id, taskDir: descriptor.taskDir, datasetDir: descriptor.datasetDir,
        workdir: descriptor.workdir, ...(descriptor.timeoutSeconds === undefined ? {} : { timeoutSeconds: descriptor.timeoutSeconds }) }, typeof descriptor.importPath === "string" ? descriptor.importPath : this.config.importPath, env,
        this.config.dockerExecutable, image, key, signal, Object.values(this.factoryRuntime.services).map(binding => binding.auth.value));
    },
  };
}
