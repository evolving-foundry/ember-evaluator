import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";
import { loadConfig } from "../../src/application/config.js";
import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { solverBinding } from "../../src/core/policies/service-bindings.js";
import { RayJobsDeployment } from "../../src/application/ray/deployment.js";
import { RayScheduler } from "../../src/plugins/schedulers/ray/scheduler.js";
import { resolveManagedLocalBundlePath } from "../../src/application/ray/managed-local.js";
import { AgentBundleSolver, parseAgentBundleConfig } from "../../src/plugins/solvers/agentbundle.js";

const playbook = (file: string) => resolve("playbook", file.startsWith("deepswe") ? "deepswe" : "workbuddy", file);

const environment = {
  JUDGE_MODEL_NAME: "judge",
  JUDGE_MODEL_ENDPOINT: "https://judge.invalid/v1",
  JUDGE_MODEL_API_KEY: "judge-secret",
  MODEL_NAME: "controlled-model",
  MODEL_ENDPOINT: "https://example.invalid/v1",
  MODEL_API_KEY: "controlled-secret",
  EVALUATOR_JOBS_TOKEN: "controlled-jobs-token",
};

test.each([
  ["deepswe-simpleagent.yaml", "local", "simpleagent"],
  ["deepswe-ray.yaml", "ray", "simpleagent"],
  ["deepswe-agentbundle-ray.yaml", "ray", "agentbundle"],
] as const)("DeepSWE playbook %s selects Harbor with the %s scheduler and %s solver", async (file, scheduler, solver) => {
  const loaded = await loadConfig(playbook(file), {}, environment);
  expect(loaded.experiment).toMatchObject({
    benchmark: { name: "harbor", config: { dataset: "deepswe@1.1", source: { kind: "github" }, scoring: { errorValues: [-1] } } },
    environment: { name: "docker" },
    solver: { name: solver },
    scheduler: { name: scheduler },
  });
  if (scheduler === "ray") {
    expect(loaded.experiment.scheduler.config).toEqual({ concurrency: 2 });
    expect(loaded.deployment).toMatchObject({ kind: "ray-jobs", managedLocal: true });
  }
  expect(loaded.experiment.run).toMatchObject({ taskIds: null, maxTasks: null });
  expect(loaded.experiment.run?.timeoutSeconds).toBe(18000);
  expect(JSON.stringify(loaded.persisted)).not.toContain("controlled-secret");
});

test("DeepSWE playbooks keep the original model endpoint while isolated containers see a mapped one", async () => {
  const loaded = await loadConfig(resolve("playbook/deepswe/deepswe-simpleagent.yaml"), {}, environment);
  expect(solverBinding(loaded).model).toMatchObject({ endpoint: "https://example.invalid/v1" });
});

test("explicit Ray Client configuration still selects the Ray Client scheduler", async () => {
  const loaded = await loadConfig(resolve("playbook/deepswe/deepswe-ray.yaml"), {}, environment);
  loaded.experiment.scheduler.config = {
    endpoint: "local",
    concurrency: 1,
    collector: { certFile: "cert.pem", keyFile: "key.pem" },
  };
  const components = await bootstrap(loaded, dirname(playbook("deepswe-ray.yaml")));
  try {
    expect(components.scheduler).toBeInstanceOf(RayScheduler);
  } finally {
    await components.dispose();
  }
});

test("the DeepSWE DSH bundle verifies with pinned provenance", async () => {
  const loaded = await loadConfig(resolve("playbook/deepswe/deepswe-agentbundle-ray.yaml"), {}, environment);
  expect(parseAgentBundleConfig(loaded.experiment.solver.config)).toEqual({ path: "./bundles/dsh-deepswe" });
  const { model, auth } = solverBinding(loaded);
  const bundle = resolve("tests/fixtures/agentbundle/dsh-deepswe");
  const solver = new AgentBundleSolver(bundle, model, auth, { installation: async () => ({ id: "fixture-dsh", files: [], commands: [], probes: [] }) });
  const provenance = await solver.provenance(AbortSignal.timeout(15_000));
  expect(provenance).toMatchObject({ harness: "dsh", harnessVersion: "0.2.2-rc.1" });
  expect(provenance.bundle).toMatch(/^sha256:[a-f0-9]{64}$/u);
});

test.each([
  ["deepswe-agentbundle-ray.yaml", "dsh-deepswe"],
  ["workbuddy-code-agentbundle-ray.yaml", "dsh-workbuddy-code"],
  ["workbuddy-office-agentbundle-ray.yaml", "dsh-workbuddy-office"],
  ["workbuddy-sec-agentbundle-ray.yaml", "dsh-workbuddy-sec"],
  ["workbuddy-web-agentbundle-ray.yaml", "dsh-workbuddy-web"],
] as const)("built-in %s declares its fixture bundle path explicitly", async (file, bundle) => {
  const loaded = await loadConfig(playbook(file), {}, environment);
  const config = parseAgentBundleConfig(loaded.experiment.solver.config);
  expect(config.path).toBe(`./bundles/${bundle}`);
  expect(resolveManagedLocalBundlePath(dirname(playbook(file)), config.path)).toBe(
    resolve("tests/fixtures/agentbundle", bundle),
  );
});

test("the built-in pi Ray playbook resolves the sibling product bundle", async () => {
  const loaded = await loadConfig(resolve("playbook/workbuddy/workbuddy-office-pi-ray.yaml"), {}, environment);
  const config = parseAgentBundleConfig(loaded.experiment.solver.config);
  expect(config).toMatchObject({
    path: "./bundles/pi",
    pi: { settings: { version: 1, office: { enabled: true, readOnly: false } } },
  });
  expect(resolveManagedLocalBundlePath(dirname(playbook("workbuddy-office-pi-ray.yaml")), config.path)).toBe(
    resolve("../pi/bundles/pi"),
  );
});

test("the local pi playbook uses the same AgentBundle Pi adapter", async () => {
  const loaded = await loadConfig(resolve("playbook/workbuddy/workbuddy-office-pi.yaml"), {}, environment);
  expect(loaded.experiment.solver.name).toBe("agentbundle");
  expect(parseAgentBundleConfig(loaded.experiment.solver.config)).toMatchObject({
    path: "../../../pi/bundles/pi",
    pi: { settings: { version: 1, office: { enabled: true, readOnly: false } } },
  });
  expect(loaded.experiment.scheduler).toMatchObject({ name: "local", config: { concurrency: 1 } });
});

test("managed local bundle mapping includes classified playbooks and excludes sibling directories", () => {
  expect(resolveManagedLocalBundlePath(resolve("playbook/deepswe"), "./bundles/dsh-deepswe"))
    .toBe(resolve("tests/fixtures/agentbundle/dsh-deepswe"));
  expect(resolveManagedLocalBundlePath(resolve("playbook-other/deepswe"), "./bundles/dsh-deepswe"))
    .toBe(resolve("playbook-other/deepswe/bundles/dsh-deepswe"));
});

test.each(["workbuddy-web-simpleagent.yaml", "workbuddy-web-ray.yaml", "workbuddy-web-agentbundle-ray.yaml"])("%s binds an independent judge service and redacts both credentials", async file => {
  const loaded = await loadConfig(playbook(file), {}, environment);
  expect(loaded.experiment.benchmark.name).toBe("harbor");
  expect(loaded.experiment.verifier).toMatchObject({ name: "harbor-python", service: "judge" });
  expect(loaded.experiment.services.judge).toMatchObject({ name: "judge", endpoint: "https://judge.invalid/v1" });
  expect(loaded.auths.judge?.value).toBe("judge-secret");
  expect(JSON.stringify(loaded.persisted)).not.toContain("judge-secret");
  expect(JSON.stringify(loaded.persisted)).not.toContain("controlled-secret");
  const missing = { ...environment, JUDGE_MODEL_API_KEY: undefined };
  await expect(loadConfig(playbook(file), {}, missing)).rejects.toThrow(/JUDGE_MODEL_API_KEY/);
});

test.each([
  "workbuddy-office-ray.yaml", "workbuddy-office-agentbundle-ray.yaml",
  "workbuddy-office-pi.yaml", "workbuddy-office-pi-ray.yaml",
  "workbuddy-office-dify.yaml", "workbuddy-code-simpleagent.yaml",
  "workbuddy-code-ray.yaml", "workbuddy-code-agentbundle-ray.yaml",
  "workbuddy-sec-simpleagent.yaml", "workbuddy-sec-ray.yaml", "workbuddy-sec-agentbundle-ray.yaml",
])("%s preserves upstream programmatic grading without judge credentials", async file => {
  const loaded = await loadConfig(playbook(file), {}, {
    ...environment, JUDGE_MODEL_NAME: undefined, JUDGE_MODEL_ENDPOINT: undefined, JUDGE_MODEL_API_KEY: undefined,
    DIFY_BASE_URL: "https://dify.invalid",
    DIFY_BUNDLE_PATH: resolve(".scratch/dify-bundle"), DIFY_REGISTRY_PATH: resolve(".scratch/dify-registry.json"),
  });
  expect(loaded.experiment.verifier?.service).toBeUndefined();
  expect(loaded.experiment.services.judge).toBeUndefined();
  if (!file.includes("-sec-")) {
    expect(loaded.experiment.verifier).toMatchObject({ name: "harbor-python", config: { requireService: false } });
  }
});
