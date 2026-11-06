import { join } from "node:path";
import { expect, test } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { apply as registryPlugin } from "../../src/application/plugins/registry.js";
import { localizePortableSelection, projectPortableSelection, validatePortableSelection } from "../../src/infrastructure/ray/protocol.js";
import { harborConfigTransport } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config-transport.js";

test("an external benchmark declares its own host fields without a Ray name list", async () => {
  const ctx = new Context();
  await ctx.plugin(registryPlugin);
  try {
    let created = false;
    ctx.evaluator.register("benchmark", "external-records", value => value, () => { created = true; throw new Error("must not create a benchmark"); },
      { nodeLocal: { dataCache: "cache", executable: "docker" }, containerPaths: [["target"]] });
    const lookup = (role: string, name: string) => ctx.evaluator.configTransport(role, name);
    const original = { name: "external-records", config: { dataCache: "C:\\client\\cache", executable: "/client/docker", target: "/workspace" } };
    const projected = projectPortableSelection(original, "benchmark", lookup);
    expect(projected.config).toEqual({ target: "/workspace" });
    expect(localizePortableSelection(projected, "benchmark", { outputRoot: "/node", dockerExecutable: "/node/docker" }, lookup).config)
      .toEqual({ dataCache: join("/node", "cache", "benchmark", "external-records"), executable: "/node/docker", target: "/workspace" });
    expect(original.config.dataCache).toBe("C:\\client\\cache");
    expect(created).toBe(false);
    expect(() => validatePortableSelection({ ...projected, config: { ...projected.config, dataCache: "relative" } }, "benchmark", lookup))
      .toThrow(/Node-local/);
    expect(() => validatePortableSelection(projected, "benchmark")).toThrow(/Node-local/);
  } finally { await ctx.fiber.dispose(); }
});

test("Harbor path rules belong to its declaration, including when registered under another name", () => {
  const lookup = () => harborConfigTransport;
  const selection = { name: "custom-harbor", config: { defaults: { workdir: "/app" }, taskProfiles: { task: { workdir: "/repo", extraPaths: ["/outputs"] } } } };
  expect(validatePortableSelection(selection, "benchmark", lookup)).toEqual(selection);
  expect(() => validatePortableSelection(selection, "benchmark")).toThrow(/Node-local/);
  expect(() => validatePortableSelection({ name: "custom-harbor", config: { source: { kind: "local", path: "relative" } } }, "benchmark", lookup))
    .toThrow(/cannot distribute/);
});

test.each([
  { path: "/client/private" },
  { path: "C:\\client\\private" },
  { cacheDir: "relative-cache" },
  { dockerExecutable: "docker" },
  { apiKey: "secret" },
  { url: "https://user:password@example.invalid" },
  { url: "https://example.invalid/data?token=secret" },
  { nested: { authorization: "secret" } },
])("undeclared host values and credentials remain rejected: %j", config => {
  expect(() => projectPortableSelection({ name: "external", config }, "benchmark")).toThrow();
});

test.each(["C:\\workspace", "//host/share", "/app/../private", "relative", "/app\\private"])("container declaration rejects unsafe path %s", target => {
  expect(() => validatePortableSelection({ name: "external", config: { target } }, "benchmark", () => ({ containerPaths: [["target"]] }))).toThrow(/container path/);
});

test("container rules do not exempt sibling fields, nested credentials or arbitrary descendants", () => {
  const lookup = () => ({ containerPaths: [["targets", "*", "path"]] });
  expect(validatePortableSelection({ name: "external", config: { targets: [{ path: "/app" }] } }, "benchmark", lookup)).toBeTruthy();
  for (const targets of [[{ path: "/app", other: "/client" }], [{ path: { nested: "/client" } }], [{ path: "/app", apiKey: "secret" }]])
    expect(() => validatePortableSelection({ name: "external", config: { targets } }, "benchmark", lookup)).toThrow();
});
