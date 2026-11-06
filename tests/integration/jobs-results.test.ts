import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import { buildResumeSeed, downloadRunResults } from "../../src/application/ray/jobs-results.js";
import type { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";

/** Serves a directory the way the jobs gateway does: manifest plus base64 chunks. */
function fakeClient(remoteRoot: string): JobsClient {
  const runDirectory = async () => join(remoteRoot, (await readdir(remoteRoot))[0]!);
  return {
    async call(path: string) {
      const manifestMatch = /^\/jobs\/([^/]+)\/manifest$/u.exec(path);
      if (manifestMatch) {
        const runId = (await readdir(remoteRoot))[0]!;
        const inventory = await buildFileManifest(await runDirectory(), []);
        return { runId, files: inventory.files, missing: inventory.missing };
      }
      const fileMatch = /^\/jobs\/[^/]+\/file\?path=([^&]+)&offset=(\d+)$/u.exec(path);
      if (!fileMatch) throw new Error(`unexpected jobs call: ${path}`);
      const relative = decodeURIComponent(fileMatch[1]!);
      const data = (await readFile(join(await runDirectory(), relative))).subarray(Number(fileMatch[2]));
      return { data: data.toString("base64") };
    },
  } as unknown as JobsClient;
}

test("downloading into an existing run directory merges manifests, reports, and new attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-jobs-results-"));
  try {
    const runId = "01234567-89ab-4cde-8f01-23456789abcd";
    const remote = join(root, "remote", runId);
    const output = join(root, "output");
    const attempt = async (id: string, status: string) => {
      await mkdir(join(remote, "tasks", "task-a", "attempts", id), { recursive: true });
      await writeFile(
        join(remote, "tasks", "task-a", "attempts", id, "result.json"),
        JSON.stringify({ key: { taskId: "task-a", attemptId: id }, status }),
      );
    };
    const writeRun = async (attemptId: string, attemptStatus: string, remoteAttempts: unknown[]) => {
      await rm(join(root, "remote"), { recursive: true, force: true });
      await attempt(attemptId, attemptStatus);
      await writeFile(
        join(remote, "manifest.json"),
        JSON.stringify({ runId, remoteAttempts }),
      );
      await writeFile(join(remote, "metrics.json"), JSON.stringify({ "success-rate": attemptStatus }));
      await writeFile(join(remote, "report.md"), `report for ${attemptId}`);
    };

    // First download creates the directory through the rename path.
    await writeRun("attempt-1", "completed", [{ key: { runId, taskId: "task-a", attemptId: "attempt-1" } }]);
    await mkdir(join(remote, "reports/resume-1"), { recursive: true });
    await writeFile(join(remote, "reports/current.json"), JSON.stringify({ directory: "resume-1" }));
    await writeFile(join(remote, "reports/resume-1/report.md"), "first resumed report");
    await downloadRunResults(fakeClient(join(root, "remote")), "job-1", output, () => {});
    const destination = join(output, runId);

    // A resumed job downloads again into the same directory: the manifests must
    // merge (raw JSON text used to reach mergeManifests and crash the download).
    await writeRun("attempt-2", "completed", [{ key: { runId, taskId: "task-a", attemptId: "attempt-2" } }]);
    await mkdir(join(remote, "reports/resume-2"), { recursive: true });
    await writeFile(join(remote, "reports/current.json"), JSON.stringify({ directory: "resume-2" }));
    await writeFile(join(remote, "reports/resume-2/report.md"), "second resumed report");
    await downloadRunResults(fakeClient(join(root, "remote")), "job-2", output, () => {});

    const merged = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
    expect(merged.runId).toBe(runId);
    expect(merged.remoteAttempts.map((item: { key: { attemptId: string } }) => item.key.attemptId).sort()).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect(await readFile(join(destination, "report.md"), "utf8")).toBe("report for attempt-2");
    expect(JSON.parse(await readFile(join(destination, "reports/current.json"), "utf8"))).toEqual({ directory: "resume-2" });
    expect(await readFile(join(destination, "reports/resume-1/report.md"), "utf8")).toBe("first resumed report");
    expect(await readFile(join(destination, "reports/resume-2/report.md"), "utf8")).toBe("second resumed report");
    await writeFile(join(destination, "tasks/task-a/attempts/attempt-2/agent.log"), "large evidence stays local");
    const packaged = await buildResumeSeed(destination);
    expect(packaged.seed["reports/current.json"]).toBe(JSON.stringify({ directory: "resume-2" }));
    expect(packaged.seed["reports/resume-1/report.md"]).toBe("first resumed report");
    expect(packaged.seed["reports/resume-2/report.md"]).toBe("second resumed report");
    expect(packaged.seed["report.md"]).toBe("report for attempt-2");
    expect(packaged.seed["tasks/task-a/attempts/attempt-2/result.json"]).toBeDefined();
    expect(packaged.seed["tasks/task-a/attempts/attempt-2/agent.log"]).toBeUndefined();
    const attempts = await readdir(join(destination, "tasks", "task-a", "attempts"));
    expect(attempts.sort()).toEqual(["attempt-1", "attempt-2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
