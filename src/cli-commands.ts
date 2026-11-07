import { Command as Commander, CommanderError, Option } from "commander";
import { resolve } from "node:path";
import type { Command } from "./cli.js";
import type { CliOverrides } from "./config/schema.js";

interface Options extends CliOverrides {
  patch?: string; taskIdsFile?: string; resume?: boolean | string; dryRun?: boolean;
  all?: boolean; yes?: boolean; benchmark?: string; output?: string; json?: boolean;
  run?: string; taskId?: string[]; requestId?: string; reason?: string;
  problem?: string; kernel?: string; out?: string; round?: string; device?: string;
  python?: string; seeds?: string; seed?: string; warmup?: string; repeat?: string; network?: string;
  timeoutMs?: string; outputLimitBytes?: string; cleanupGraceMs?: string; cleanupTimeoutMs?: string;
  maxAttempts?: string; attemptTimeoutSeconds?: string; cacheMaxEntries?: string; retryDelayMs?: string;
}

export class CommandUsageError extends TypeError {
  constructor(message: string, readonly helpText: string) { super(message); }
}

export function parseCommand(argv: string[]): Command {
  let result: Command | undefined;
  let help = "";
  const program = new Commander("ember-evaluator")
    .description("Run benchmark experiments, inspect configuration, and rebuild saved reports.")
    .exitOverride().configureOutput({ writeOut: text => { help += text; }, writeErr: text => { help += text; } });
  program.addHelpText("after", "\nExamples:\n  ember-evaluator run experiment.yaml\n  ember-evaluator run --help\n  ember-evaluator report <run-dir>\n\nUse <command> --help for parameter details.");
  const patch = (cmd: Commander) => cmd.option("--patch <path>", "Load an explicit plugin patch; path is relative to the current directory");
  const network = (cmd: Commander) => cmd.option("--network <yaml>", "Use this network YAML for source endpoints, proxies, and download settings");
  const networkOptions = (opts: Options) => opts.network === undefined ? {} : { networkConfigPath: resolve(opts.network) };
  const model = (cmd: Commander) => cmd
    .option("--model <name>", "Override the solver model name")
    .option("--endpoint <url>", "Override the model API base URL")
    .addOption(new Option("--api-key <key>", "Provide the model API key (prefer --api-key-env to avoid shell history)").conflicts("apiKeyEnv"))
    .option("--api-key-env <name>", "Read the model API key from this environment variable");
  const progress = (cmd: Commander) => cmd.addOption(new Option("--progress <mode>", "Progress display: auto detects a terminal, tty forces live display, plain prints logs").choices(["auto", "tty", "plain"]).default("auto"));
  const common = (opts: Options) => {
    const overrides: CliOverrides = {};
    for (const key of ["model", "endpoint", "apiKey", "apiKeyEnv"] as const) {
      const value = opts[key];
      if (value !== undefined) overrides[key] = value;
    }
    return { overrides, ...networkOptions(opts), ...(opts.patch === undefined ? {} : { patchPath: resolve(opts.patch) }) };
  };
  for (const name of ["run", "warmup", "doctor", "inspect"] as const) {
    const cmd = network(patch(program.command(name).description(name === "run" ? "Execute an experiment and save results" : name === "warmup" ? "Prepare task images and runtimes without solving tasks" : name === "inspect" ? "Show resolved experiment and network settings without download probes" : "Check experiment configuration, runtime prerequisites, and network connectivity")
      .argument("<yaml>", "Experiment YAML file")));
    if (name === "run") model(cmd);
    if (name === "run" || name === "warmup") {
      progress(cmd).option("--task-ids-file <json>", "Select tasks from a JSON object containing a taskIds array; overrides sampling");
    }
    if (name === "run") cmd.option("--dry-run", "Resolve the dataset and list selected task IDs without solving tasks")
      .addOption(new Option("--resume [run-id]", "Resume a saved run; omit the ID to select automatically").conflicts("dryRun"));
    cmd.addHelpText("after", `\nExample:\n  ember-evaluator ${name} experiment.yaml`);
    cmd.action((file: string, opts: Options) => {
      result = { kind: name === "run" && opts.dryRun ? "dry-run" : name, file, ...common(opts),
        ...(opts.taskIdsFile === undefined ? {} : { taskIdsFile: opts.taskIdsFile }),
        ...(opts.resume === undefined ? {} : { resume: opts.resume === true ? null : String(opts.resume) }) };
    });
  }
  const benchmark = program.command("benchmark").description("Discover benchmarks, supported versions, and scenarios");
  patch(benchmark.command("list").description("List benchmark versions, defaults, and scenarios as a table"))
    .option("--json", "Output structured benchmark metadata as JSON")
    .action((opts: Options) => { result = { kind: "benchmark-list", json: opts.json ?? false, ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) }; });
  patch(benchmark.command("info").description("Show benchmark details and resolved settings for each version").argument("<name>", "Registered benchmark name"))
    .action((name: string, opts: Options) => { result = { kind: "benchmark-info", name, ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) }; });
  patch(program.command("init").description("Create an experiment YAML from benchmark defaults")
    .requiredOption("--benchmark <name>", "Registered benchmark to initialize")
    .requiredOption("--output <yaml>", "Destination YAML file (existing files are not overwritten)"))
    .action((opts: Options) => { result = { kind: "init", name: String(opts.benchmark), output: resolve(String(opts.output)), ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) }; });
  program.command("report").description("Rebuild metrics and report.md from saved results without a model API key")
    .argument("<run-dir>", "Directory containing a saved run")
    .action((directory: string) => { result = { kind: "report", directory }; });
  network(progress(program.command("retry").description("Retry network failures within an existing run")))
    .requiredOption("--run <id-or-directory>", "Saved run ID or run directory")
    .option("--task-id <id>", "Restrict retries to this task; may be repeated", (value: string, previous: string[]) => [...previous, value], [])
    .option("--request-id <id>", "Idempotency identifier for this retry request")
    .option("--reason <text>", "Reason recorded with the retry request")
    .action((opts: Options) => { result = { kind: "retry", run: String(opts.run), taskIds: opts.taskId ?? [], ...networkOptions(opts), ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }), ...(opts.reason === undefined ? {} : { reason: opts.reason }) }; });
  patch(program.command("cleanup").description("Manage evaluator resources").command("images").description("Preview evaluator image references; remove them only with --yes")
    .argument("[yaml]", "Experiment YAML defining the image scope")
    .option("--all", "Include all evaluator image references; required when YAML is omitted")
    .option("--yes", "Execute removal; without this flag only preview affected references"))
    .action((file: string | undefined, opts: Options) => {
      if (!file && !opts.all) throw new TypeError("Image cleanup requires YAML or --all");
      if (!file && opts.patch) throw new TypeError("--patch requires YAML");
      result = { kind: "cleanup-images", all: opts.all ?? false, execute: opts.yes ?? false, ...(file ? { file } : {}), ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) };
    });
  const kernel = program.command("kernel").description("Measure kernel performance, precision, or profiling data");
  const integer = (raw: string | undefined, fallback: number, flag: string) => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${flag} must be a non-negative integer`);
    return value;
  };
  for (const name of ["bench", "precision", "profile"] as const) {
    const cmd = kernel.command(name).description(name === "bench" ? "Verify a kernel, then benchmark its performance" : name === "precision" ? "Check kernel correctness with selected random seeds" : "Collect kernel profiling metrics independently")
      .requiredOption("--problem <path>", "Problem definition path")
      .requiredOption("--kernel <path>", "Kernel implementation path")
      .requiredOption("--out <json>", "Destination JSON result file")
      .option("--device <n>", "NPU device index", "0")
      .option("--timeout-ms <n>", "Overall worker timeout in milliseconds; 0 disables it (bench/precision default: 900000)")
      .option("--output-limit-bytes <n>", "Explicit per-stream output capacity; omitted preserves complete output")
      .option("--python <executable>", "Python interpreter used by the kernel executor");
    if (name === "profile") cmd.option("--round <n>", "Profiling round index", "0")
      .option("--seed <n>", "Replay input seed", "0")
      .option("--warmup <n>", "Warmup calls before capture", "25")
      .option("--max-attempts <n>", "Maximum profiler capture attempts including the first (default: 2)")
      .option("--attempt-timeout-seconds <n>", "Timeout per profiler capture attempt (default: 300)")
      .option("--retry-delay-ms <n>", "Wait before each capture retry; 0 disables waiting (default: exponential)")
      .option("--cleanup-grace-ms <n>", "Grace period before forcing process termination (default: 100)")
      .option("--cleanup-timeout-ms <n>", "Wait to confirm profiler cleanup (default: 3000)")
      .option("--cache-max-entries <n>", "Maximum profiling cache entries; omitted disables eviction");
    if (name === "bench") cmd.option("--warmup <n>", "Warmup timing calls", "25")
      .option("--repeat <n>", "Measured timing calls", "100");
    if (name === "precision") cmd.option("--seeds <list>", 'Space-separated random seeds; quote the list, e.g. --seeds "0 1"', "0 1");
    cmd.action((opts: Options) => {
      const base = { problem: resolve(String(opts.problem)), kernel: resolve(String(opts.kernel)), out: resolve(String(opts.out)), device: integer(opts.device, 0, "--device"), ...(opts.python === undefined ? {} : { python: opts.python }) };
      const processOptions: { timeoutMs?: number; outputLimitBytes?: number; cleanupGraceMs?: number; cleanupTimeoutMs?: number } = {};
      for (const [key, flag] of [["timeoutMs", "--timeout-ms"], ["outputLimitBytes", "--output-limit-bytes"], ["cleanupGraceMs", "--cleanup-grace-ms"], ["cleanupTimeoutMs", "--cleanup-timeout-ms"]] as const) {
        if (opts[key] === undefined) continue;
        const value = integer(opts[key], 0, flag);
        if (key !== "timeoutMs" && value === 0) throw new TypeError(`${flag} must be a positive integer`);
        processOptions[key] = value;
      }
      const profileOptions: { maxAttempts?: number; attemptTimeoutSeconds?: number; cacheMaxEntries?: number; retryDelayMs?: number } = {};
      for (const [key, flag] of [["maxAttempts", "--max-attempts"], ["attemptTimeoutSeconds", "--attempt-timeout-seconds"], ["cacheMaxEntries", "--cache-max-entries"], ["retryDelayMs", "--retry-delay-ms"]] as const) {
        if (opts[key] === undefined) continue;
        const value = integer(opts[key], 0, flag);
        if (key !== "retryDelayMs" && value === 0) throw new TypeError(`${flag} must be a positive integer`);
        profileOptions[key] = value;
      }
      result = name === "profile" ? { kind: "kernel-profile", ...base, ...processOptions, ...profileOptions, round: integer(opts.round, 0, "--round"), seed: integer(opts.seed, 0, "--seed"), warmup: integer(opts.warmup, 25, "--warmup") }
        : name === "precision" ? { kind: "kernel-precision", ...base, ...processOptions, seeds: (opts.seeds ?? "0 1").split(/\s+/).map(Number).filter(seed => Number.isSafeInteger(seed) && seed >= 0) }
        : { kind: "kernel-bench", ...base, ...processOptions, warmup: integer(opts.warmup, 25, "--warmup"), repeat: integer(opts.repeat, 100, "--repeat") };
    });
  }
  // Preserve rejection of duplicate scalar options, which Commander otherwise overwrites.
  const configure = (cmd: Commander) => {
    cmd.exitOverride().allowExcessArguments(false).showHelpAfterError();
    for (const option of cmd.options) {
      let seen = false;
      cmd.on(`option:${option.name()}`, () => {
        if (seen && option.long !== "--task-id") throw new TypeError(`Repeated ${option.long} option`);
        seen = true;
      });
    }
    for (const child of cmd.commands) configure(child);
  };
  configure(program);
  if (!argv.length) return { kind: "help", text: program.helpInformation() };
  try { program.parse(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.help"].includes(error.code)) return { kind: "help", text: help, ...(error.exitCode === 0 ? {} : { exitCode: 2 }) };
    if (error instanceof CommanderError) throw new CommandUsageError(error.message, help || program.helpInformation());
    throw error;
  }
  if (!result) throw new TypeError("Choose a subcommand; use --help for available commands");
  return result;
}
