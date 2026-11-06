import { expect, test } from "vitest";
import { parseInstalledBundle } from "../../src/runtimes/agentbundle/cli.js";
import { parse } from "yaml";
import { dshModelPatch } from "../../src/runtimes/dsh/model.js";
import { agentBundleModel, parseAgentBundleConfig } from "../../src/plugins/solvers/agentbundle.js";

const model = { name: "office-model", endpoint: "https://example.invalid/v1", provider: null, api: "openai-completions" };

test("binds agentbundle.maxTokens into the DSH provider patch", () => {
  const config = parseAgentBundleConfig({ path: "bundle", maxTokens: 131072 });
  expect(config).toEqual({ path: "bundle", maxTokens: 131072 });

  const patch = parse(dshModelPatch(agentBundleModel(model, config.maxTokens, "default")));
  expect(patch.find((entry: { id: string }) => entry.id === "llm-pi-ai").config.providers["ember-evaluator"].models).toEqual([
    { id: "office-model", maxTokens: 131072 },
  ]);
  expect(agentBundleModel(model, undefined, "default")).toBe(model);
});

test("accepts the jiuwenswarm home option and rejects unknown solver fields", () => {
  expect(parseAgentBundleConfig({ path: "bundle", jiuwenswarmhome: "/tmp/jw-home" })).toEqual({
    path: "bundle",
    jiuwenswarmhome: "/tmp/jw-home",
  });
  expect(() => parseAgentBundleConfig({ path: "bundle", unknownOption: 1 })).toThrow(/unknown field unknownOption/);
});

test("accepts a positive jiuwenswarm process timeout and rejects invalid deadlines", () => {
  expect(parseAgentBundleConfig({ path: "bundle", jiuwenswarmTimeoutSeconds: 1200 })).toEqual({
    path: "bundle",
    jiuwenswarmTimeoutSeconds: 1200,
  });
  for (const jiuwenswarmTimeoutSeconds of [0, -1, 1.5, "1200", null, true, Infinity]) {
    expect(() => parseAgentBundleConfig({ path: "bundle", jiuwenswarmTimeoutSeconds })).toThrow(
      /agentbundle\.jiuwenswarmTimeoutSeconds/,
    );
  }
});

test("parses Pi settings as a harness-specific execution configuration", () => {
  expect(parseAgentBundleConfig({
    path: "bundle",
    pi: { settings: { version: 1, office: { enabled: true, readOnly: false } } },
  })).toEqual({
    path: "bundle",
    pi: { settings: { version: 1, office: { enabled: true, readOnly: false } } },
  });
  expect(() => parseAgentBundleConfig({ path: "bundle", pi: { profile: "evaluator-office" } })).toThrow(
    /unknown field profile/,
  );
});

test("parses the Pi coding directory from the AgentBundle CLI wire field", () => {
  expect(parseInstalledBundle({
    digest: "sha256:fixture",
    harness: { name: "pi", versionRange: ">=0.1 <0.2", actualVersion: "0.1.0" },
    home: "/runtime/home",
    profile: "pi",
    reused: false,
    installationId: "pi-fixture",
    "coding-agent-dir": "/runtime/home/agent",
  }).codingAgentDir).toBe("/runtime/home/agent");
});

test("parses Dify options under agentbundle and rejects old solver fields", () => {
  expect(parseAgentBundleConfig({ path: "bundle", dify: { baseUrl: "https://dify.example///", registryPath: "registry.json" } })).toEqual({
    path: "bundle", dify: { baseUrl: "https://dify.example", registryPath: "registry.json" },
  });
  for (const field of ["bundlePath", "baseUrl", "apiKeyEnv", "appId", "registryPath"]) {
    expect(() => parseAgentBundleConfig({ path: "bundle", [field]: "old" })).toThrow(/unknown field/);
  }
  for (const dify of [null, {}, { baseUrl: "" }, { baseUrl: "https://dify.example", apiKeyEnv: "OLD" }]) {
    expect(() => parseAgentBundleConfig({ path: "bundle", dify })).toThrow();
  }
});

test.each(["not-a-url", "file:///tmp/dify", "https://user:password@dify.example", "https://dify.example?token=secret",
  "https://dify.example#secret", "https://dify.example/v1", "https://dify.example/v1/workflows/run"])(
  "rejects an invalid Dify service address: %s", baseUrl => {
    expect(() => parseAgentBundleConfig({ path: "bundle", dify: { baseUrl } })).toThrow(/agentbundle.dify.baseUrl/);
  },
);
