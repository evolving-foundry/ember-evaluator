import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";

// ── 可配置项（均可被环境变量覆盖，便于复用其它任务/模型）────────────────
const bundlePath = process.env.HERMES_BUNDLE_PATH ?? resolve("tests/fixtures/agentbundle/hermes");
const taskDir = process.env.WORKBUDDY_TASK_DIR ?? "/home/chencong/ember-evaluator-fork1/.cache/workbuddy/datasets/89d4480b483ca2e0555ba96cc7d73c16c78802b17cd822044d5f7f27ab0558bf/wb-bench-office-v1.0/tasks/analyst-forecast-extract-L3-018";
const modelName = process.env.MODEL_NAME ?? "qwen3.8-flash";
const modelEndpoint = process.env.MODEL_ENDPOINT ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 同步执行一个外部命令并返回 stdout（用于 tar / docker 编排）。 */
function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 确保 wb-office-task 镜像存在；没有就用 aliyun 镜像源在临时目录构建（网络原因，见文档）。 */
async function ensureOfficeImage(): Promise<void> {
  try { run("docker", ["image", "inspect", "wb-office-task"]); return; } catch { /* 需要构建 */ }
  const buildDir = join(resolve(".scratch"), "office-image");
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  // 读任务自带 Dockerfile，仅在 pip 行加 aliyun 镜像源，不改数据集原文件
  const original = await readFile(join(taskDir, "environment", "Dockerfile"), "utf8");
  const patched = original.replace(
    "pip install --no-cache-dir",
    "pip install --no-cache-dir --index-url https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com",
  );
  await writeFile(join(buildDir, "Dockerfile"), patched);
  await cp(join(taskDir, "environment", "workspace.tar.gz"), join(buildDir, "workspace.tar.gz"));
  run("docker", ["build", "--progress=plain", "-t", "wb-office-task", "-f", join(buildDir, "Dockerfile"), buildDir]);
}

/** 用官方 score.py（零改动）在 docker 里对 solve 产出打分，返回 reward 数值。 */
async function dockerScore(workdir: string): Promise<number> {
  await ensureOfficeImage();
  const logs = join(resolve(".scratch"), "office-score-logs");
  // 上一次 docker verifier 以 root 写日志，宿主机普通用户无法 unlink；先用 docker 清理再 rm
  run("docker", ["run", "--rm", "-v", resolve(".scratch") + ":/scratch", "wb-office-task", "rm", "-rf", "/scratch/office-score-logs"]);
  await rm(logs, { recursive: true, force: true });
  await mkdir(logs, { recursive: true });
  try { run("docker", ["rm", "-f", "wb-verify"]); } catch { /* 不存在则忽略 */ }
  try {
    run("docker", ["run", "-d", "--name", "wb-verify",
      "-v", workdir + ":/workspace",
      "-v", taskDir + "/tests:/tests",
      "-v", logs + ":/logs/verifier",
      "wb-office-task", "sleep", "infinity"]);
    run("docker", ["cp", join(resolve("."), "src/infrastructure/workbuddy/python/score.py"), "wb-verify:/tests/evaluator-office-score.py"]);
    run("docker", ["cp", join(resolve("."), "src/infrastructure/workbuddy/python/evaluator_failed_checks.py"), "wb-verify:/tests/evaluator_failed_checks.py"]);
    const out = run("docker", ["exec", "-w", "/workspace", "wb-verify", "python", "-I", "/tests/evaluator-office-score.py"]);
    console.log("\n=== score.py 输出 ===\n" + out);
    const rewardText = run("docker", ["exec", "wb-verify", "cat", "/logs/verifier/reward.txt"]);
    return Number(rewardText.trim());
  } finally {
    try { run("docker", ["rm", "-f", "wb-verify"]); } catch { /* 忽略 */ }
  }
}

test("AgentBundleSolver 用真实模型解真实 office 任务，官方 docker verifier 打出真实分", async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("缺少 OPENAI_API_KEY（真实模型调用需要）");

  const root = resolve(".scratch/office-hermes-real");
  const workspaces = join(root, "workspaces");
  const cache = join(root, "cache");
  await Promise.all([mkdir(cache, { recursive: true }), mkdir(workspaces, { recursive: true })]);
  const runDir = await mkdtemp(join(root, "run-"));

  // ── PHASE 0：解出任务初始文件（input/ 资料包），交给本地环境 ──
  const extracted = join(runDir, "task-input");
  await mkdir(extracted, { recursive: true });
  run("tar", ["xzf", join(taskDir, "environment", "workspace.tar.gz"), "-C", extracted]);

  const solver = new AgentBundleSolver(bundlePath, {
    name: modelName,
    endpoint: modelEndpoint,
    provider: null,
    api: "openai-completions",
  }, { value: apiKey, reference: "OPENAI_API_KEY" });

  const signal = AbortSignal.timeout(30 * 60_000);
  try {
    // ── PHASE 1：Evaluator 的 hermes 适配 → 真实 hermes 求解 ──
    const installation = await solver.runtimeInstallation(signal);
    const environment = new LocalEnvironment(workspaces, cache);
    const attempt = join(runDir, "attempt-1");
    const paths = { root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts") };
    await mkdir(paths.agent, { recursive: true });
    const context = { key: { runId: "office-hermes-real", taskId: "analyst-forecast-extract-L3-018", attemptId: "attempt-1" }, paths, signal };

    const session = await environment.prepare({
      workdir: ".",
      image: null,
      initialFiles: [
        { source: join(extracted, "input"), target: "input" },
        { source: join(extracted, "output"), target: "output" },
      ],
      runtime: solver.requirements(),
      installation,
    }, paths, "solve", signal);
    const prepared = await solver.prepare(session, context);
    try {
      const instruction = await readFile(join(taskDir, "instruction.md"), "utf8");
      const result = await prepared.solve({ id: "analyst-forecast-extract-L3-018", prompt: instruction }, context);
      console.log("\n=== hermes 求解完成，finalText 摘要 ===\n" + result.finalText.slice(0, 600) + "\n");
      expect(result.usage).toBeDefined();
      expect(result.finalText.length).toBeGreaterThan(0);

      // 交付物应落在 solve 工作区 output/ 下（agent 按指令写入 cwd/output）
      const xlsx = join(session.workdir, "output", "analyst_forecast_extract.xlsx");
      const json = join(session.workdir, "output", "analyst_forecast_extract.json");
      await Promise.all([stat(xlsx), stat(json)]);
      console.log("交付物已生成：", xlsx, " | ", json);

      // ── PHASE 2：官方 docker verifier（score.py 原样）打分 ──
      const reward = await dockerScore(session.workdir);
      console.log("\n=== 真实 reward ===\n" + reward);
      expect(Number.isFinite(reward)).toBe(true);
      expect(reward).toBeGreaterThanOrEqual(0);
      expect(reward).toBeLessThanOrEqual(1);
    } finally {
      try { await prepared.dispose?.(AbortSignal.timeout(5000)); } catch { /* 忽略清理错误 */ }
      try { await session.dispose(AbortSignal.timeout(5000)); } catch { /* 忽略清理错误 */ }
    }
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}, 40 * 60_000);
