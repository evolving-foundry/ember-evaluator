import type { EnvironmentSpec } from "../../../../core/contracts/environment.js";
import type { JsonValue, PreparedTask } from "../../../../core/contracts/task.js";
import { buildFileManifest } from "../../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";

/** Explicit input shared by workspace archive benchmarks; never contains verifier data. */
export type WorkspaceArchiveTaskDescription = {
  id: string;
  prompt: string;
  image: string | null;
  context: string | null;
  dockerfile: string | null;
  resources: NonNullable<EnvironmentSpec["resources"]>;
  workdir: string;
  extraPaths: string[];
  phaseTimeoutSeconds?: PreparedTask["phaseTimeoutSeconds"];
  /** Verify-phase container network restriction (e.g. sec no-network verifiers). */
  verifyNetwork?: "none";
  /** Share /logs between solve and verify (sec agents write /logs/artifacts). */
  sharedLogs?: boolean;
};

export async function buildWorkspaceArchiveTask(
  description: WorkspaceArchiveTaskDescription,
  unsafeContext: () => Error,
): Promise<Omit<PreparedTask, "verification">> {
  const manifest = description.context === null ? null : await buildFileManifest(description.context, []);
  if (manifest?.missing.length) throw unsafeContext();
  const environment: EnvironmentSpec = {
    workdir: description.workdir,
    image: description.image,
    runtime: [],
    initialFiles: [],
    resources: { ...description.resources },
    ...(description.sharedLogs === true ? { sharedLogs: true } : {}),
    ...(description.context === null || description.dockerfile === null || manifest === null
      ? {}
      : {
          build: {
            context: description.context,
            dockerfile: description.dockerfile,
            sourceHash: fingerprintConfig(manifest.files as unknown as JsonValue),
          },
        }),
  };
  const verifyEnvironment = structuredClone(environment);
  if (description.verifyNetwork === "none") verifyEnvironment.network = "none";
  return {
    input: { id: description.id, prompt: description.prompt },
    solveEnv: environment,
    verifyEnv: verifyEnvironment,
    transfer: { kind: "workspace-archive", workdir: description.workdir, extraPaths: [...description.extraPaths] },
    ...(description.phaseTimeoutSeconds === undefined
      ? {}
      : { phaseTimeoutSeconds: { ...description.phaseTimeoutSeconds } }),
  };
}
