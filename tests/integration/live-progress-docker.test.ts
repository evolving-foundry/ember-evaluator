import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LiveOperation } from "../../src/core/progress/live-progress.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { observeDockerCommand, withDockerActivity } from "../../src/infrastructure/containers/progress.js";

test.skipIf(process.env.EVALUATOR_LIVE_PROGRESS_DOCKER_TESTS !== "1")("real BuildKit output arrives before completion and failed builds retain their last operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-buildkit-"));
  const tag = `evaluator-live-progress-test:${randomUUID()}`;
  const events: ProgressEvent[] = []; let completed = false; let streamed = false;
  const operation = new LiveOperation(event => {
    events.push(event);
    if (event.live?.lines.some(line => /^#\d/u.test(line))) { expect(completed).toBe(false); streamed = true; }
  }, { phase: "prepare", message: "真实镜像构建" });
  const command = observeDockerCommand((args, options) => runDockerCommand("docker", args, options));
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY marker /marker\nLABEL evaluator.live-progress=test\n");
    await writeFile(join(root, "marker"), "public fixture\n");
    await withDockerActivity(operation.activity, () => command(["build", "--tag", tag, root], { signal: AbortSignal.timeout(45_000) }));
    operation.finish(); completed = true;
    expect(streamed).toBe(true); expect(events.some(event => event.live?.parentId && event.live.status === "completed")).toBe(true);
    const failed: ProgressEvent[] = [];
    const failure = new LiveOperation(event => failed.push(event), { phase: "prepare", message: "受控失败构建" });
    await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY missing-file /missing\n");
    await expect(withDockerActivity(failure.activity, () => command(["build", root], { signal: AbortSignal.timeout(45_000) }))).rejects.toThrow();
    failure.finish("failed");
    expect(failed.some(event => event.live?.status === "failed" && event.live.lines.length > 0)).toBe(true);
  } finally {
    operation.finish("cancelled");
    await runDockerCommand("docker", ["image", "rm", tag], { signal: AbortSignal.timeout(15_000) }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
