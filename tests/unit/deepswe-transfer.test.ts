import { expect, test } from "vitest";
import { validateGitPatchSpec, GitPatchError } from "../../src/plugins/environments/shared/git-patch.js";
import { parseModelEndpointPolicy } from "../../src/infrastructure/network/model-gateway.js";
import type { TransferSpec } from "../../src/core/contracts/environment.js";

const spec: TransferSpec = {
  kind: "git-patch",
  workdir: "/app",
  baseCommit: "11614be9021aa4ac078d4d0693a8b5250a1010d8",
  target: "/logs/artifacts/model.patch",
};

test("accepts the official patch specification and abbreviated base commits", () => {
  expect(() => validateGitPatchSpec(spec, "/app")).not.toThrow();
  const abbreviated: TransferSpec = { ...spec, baseCommit: "68dafce" };
  expect(() => validateGitPatchSpec(abbreviated, "/app")).not.toThrow();
});

test("rejects mismatched workdirs and invalid base commits", () => {
  expect(() => validateGitPatchSpec(spec, "/workspace")).toThrow(GitPatchError);
  for (const baseCommit of ["", "abc", "not-hex", `${"a".repeat(41)}`, "HEAD~1"]) {
    expect(() => validateGitPatchSpec({ ...spec, baseCommit }, "/app"), baseCommit).toThrow(/base commit/);
  }
});

test("rejects unsafe restore targets while /logs artifacts stay allowed", () => {
  for (const target of [
    "relative/patch",
    "/",
    "/proc/patch",
    "/sys/patch",
    "/dev/patch",
    "/opt/evaluator/patch",
    "/opt/evaluator-agent/patch",
    "/tests/patch",
    "/solution/patch",
    "/logs/../etc/patch",
    "/logs/..\\patch",
  ]) {
    expect(() => validateGitPatchSpec({ ...spec, target }, "/app"), target).toThrow(/target/i);
  }
  expect(() => validateGitPatchSpec({ ...spec, target: "/logs/artifacts/model.patch" }, "/app")).not.toThrow();
});

test("workspace archives remain a distinct transfer kind", () => {
  const archive: TransferSpec = { kind: "workspace-archive", workdir: "/app", extraPaths: [] };
  expect(() => validateGitPatchSpec(archive, "/app")).toThrow(/Git patch/);
});

test("parses model endpoint policies into origin and prefix", () => {
  expect(parseModelEndpointPolicy("https://api.example.com/v1")).toEqual({
    origin: "https://api.example.com",
    pathPrefix: "/v1",
  });
  expect(parseModelEndpointPolicy("http://10.0.0.1:8000/api/v1")).toEqual({
    origin: "http://10.0.0.1:8000",
    pathPrefix: "/api/v1",
  });
  expect(parseModelEndpointPolicy("https://api.example.com/")).toEqual({
    origin: "https://api.example.com",
    pathPrefix: "",
  });
  expect(parseModelEndpointPolicy("https://api.example.com/v1/")).toEqual({
    origin: "https://api.example.com",
    pathPrefix: "/v1",
  });
});

test("rejects model endpoints that could smuggle credentials or ambiguity", () => {
  for (const endpoint of [
    "ftp://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1?token=x",
    "https://api.example.com/v1#frag",
    "not a url",
    "https://api.example.com//v1",
  ]) {
    expect(() => parseModelEndpointPolicy(endpoint), endpoint).toThrow(/CONFIG_INVALID/);
  }
});
