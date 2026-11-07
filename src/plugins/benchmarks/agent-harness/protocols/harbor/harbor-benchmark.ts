import type { HardwareKind } from "../../../../../core/contracts/hardware.js";
import type { PhaseTimeoutOverrides } from "../../../../../core/contracts/task.js";
import type { Benchmark } from "../../../../../core/contracts/benchmark.js";
import type { Verifier } from "../../../../../core/contracts/verifier.js";
import { planBenchmarkRun } from "../../../shared/plan-run.js";
import { createHarborSource, transportDefault, type HarborTransport } from "./source.js";
import { createDirectoryBenchmarkSource } from "./directory-source.js";
import type { HarborConfig } from "./config.js";
import { HarborShellVerifier } from "../../../../verifiers/shell.js";
import { scoreHarborEvidence } from "./verify.js";
import { evaluateHarborSteps } from "./steps.js";
import type { VerificationRuntime } from "../../../../../core/contracts/verification-runtime.js";

export class HarborBenchmark implements Benchmark {
  readonly evaluateSteps: NonNullable<Benchmark["evaluateSteps"]> = (task, results) => evaluateHarborSteps(task, results, this.config.scoring);
  readonly verificationRuntime?: VerificationRuntime;
  readonly validateSourceOnCompletedResume = true;
  readonly resolveSource: Benchmark["resolveSource"];
  readonly enumerate: Benchmark["enumerate"];
  readonly prepare: Benchmark["prepare"];
  readonly planRun: NonNullable<Benchmark["planRun"]> = (refs, source, signal, activity) =>
    planBenchmarkRun(this, refs, source, signal, { version: "task-preparation-v1", source: "HarborBenchmark:declared-build-timeouts" },
      this.config.defaults.buildTimeoutSeconds, activity);
  constructor(
    readonly config: HarborConfig,
    transport: HarborTransport = transportDefault,
    private readonly verifier: Verifier = new HarborShellVerifier(),
    phaseTimeouts: PhaseTimeoutOverrides = {},
    hardware: HardwareKind = "npu",
    network?: import("../../../../../core/contracts/network.js").NetworkAccess,
  ) {
    const source = config.source ? createDirectoryBenchmarkSource(config, verifier, transport, phaseTimeouts, hardware, network) : createHarborSource(config, transport, verifier, phaseTimeouts, hardware, network);
    this.resolveSource = source.resolveSource;
    this.enumerate = source.enumerate;
    this.prepare = source.prepare;
    const runtime = verifier.runtime;
    if (runtime) this.verificationRuntime = {
      materialize: (task, signal, activity) => runtime.materialize(task.verification, signal, activity),
      ...(runtime.recoverAttempts ? { recoverAttempts: (keys, signal) => runtime.recoverAttempts!(keys, signal) } : {}),
      prepare: async (task, receipt, context) => {
        const handle = await runtime.prepare(task.verification, receipt, context);
        return { metadata: handle.metadata, dispose: signal => handle.dispose(signal),
          verify: async (result, session, signal) => scoreHarborEvidence(await handle.verify(result, session, signal), this.config.scoring) };
      },
    };
  }
  readonly verify: Benchmark["verify"] = async (task, _result, session, signal) => {
    if (!session) throw new Error("Harbor verification requires an execution environment");
    return scoreHarborEvidence(await this.verifier.verify(task.verification, session, signal), this.config.scoring);
  };
}
