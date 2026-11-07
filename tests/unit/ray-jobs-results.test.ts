import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localizeRunPluginRuntime } from "../../src/application/ray/jobs-results.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("localizeRunPluginRuntime", () => {
  it("uses submitter paths for offline reports and preserves coordinator provenance", async () => {
    const runDirectory = await mkdtemp(join(tmpdir(), "ray-jobs-result-"));
    directories.push(runDirectory);
    const localConfigDirectory = resolve("experiments/local");
    const localPatchPath = resolve("plugins/cordis.patch.yaml");
    const manifestPath = join(runDirectory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "6e3464ad-1d4a-4ea8-8dd8-9fc2927b5f48",
        pluginRuntime: {
          configDirectory: "/experiment",
          patchPath: "/experiment/cordis.patch.yaml",
          entries: [{ id: "fixture", name: "./plugin.js" }],
        },
      }),
    );

    await localizeRunPluginRuntime(runDirectory, localConfigDirectory, localPatchPath);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      pluginRuntime: {
        configDirectory: string;
        patchPath: string;
        coordinatorConfigDirectory?: string;
        coordinatorPatchPath?: string;
      };
    };
    expect(manifest.pluginRuntime.configDirectory).toBe(localConfigDirectory);
    expect(manifest.pluginRuntime.coordinatorConfigDirectory).toBe("/experiment");
    expect(manifest.pluginRuntime.patchPath).toBe(localPatchPath);
    expect(manifest.pluginRuntime.coordinatorPatchPath).toBe("/experiment/cordis.patch.yaml");
  });
});
