import { expect, test } from "vitest";
import { dockerImageUser } from "../../src/infrastructure/containers/image-user.js";

test.each(["", "root", "nobody", "1001:1002", "app:workers"])("preserves the declared image USER %j", async user => {
  expect(await dockerImageUser(async () => ({ stdout: JSON.stringify(user), stderr: "" }), "sha256:fixture", "linux/amd64", AbortSignal.timeout(1000))).toBe(user || "0");
});

test.each([null, 1, "app\nRUN injected", "app --flag", "app:group:other"])("rejects malformed image USER %j before building", async user => {
  await expect(dockerImageUser(async () => ({ stdout: JSON.stringify(user), stderr: "" }), "sha256:fixture", "linux/amd64", AbortSignal.timeout(1000))).rejects.toThrow("Invalid Docker image USER");
});
