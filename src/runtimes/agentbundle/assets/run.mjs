#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createBundleSdk, errorMessage, harnessNameForKind, resolveDshCommand, resolveHermesCommand } from "agent-bundle-core";
import { satisfies, valid, validRange } from "semver";

const require = createRequire(import.meta.url);

function packageJson(specifier) {
  let dir = dirname(require.resolve(specifier));
  for (;;) {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot locate package.json for ${specifier}`);
    dir = parent;
  }
}

const coreManifest = packageJson("agent-bundle-core");

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${coreManifest.version}\n`);
  process.exit(0);
}

const options = {};
const positionals = [];
let command;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--json") continue;
  if (arg === "--expect-digest" || arg === "--harness-version" || arg === "--home" || arg === "--profile") {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    options[arg] = value;
    index += 1;
    continue;
  }
  if (command === undefined && (arg === "verify" || arg === "install")) {
    command = arg;
    continue;
  }
  if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  positionals.push(arg);
}

if (command === undefined || positionals.length !== 1) {
  fail("usage: run.mjs --json <verify|install> <bundle> [--expect-digest D] [--harness-version V] [--home H] [--profile P]");
}

try {
  const bundleDir = positionals[0];
  const verified = await createBundleSdk().verify(bundleDir, {
    ...(options["--expect-digest"] === undefined ? {} : { expectDigest: options["--expect-digest"] }),
  });
  const harness = {
    name: harnessNameForKind(verified.manifest.kind),
    versionRange: verified.manifest.harnessVersion,
  };
  if (options["--harness-version"] !== undefined) {
    assertCompatible(options["--harness-version"], harness.versionRange);
    harness.actualVersion = options["--harness-version"];
  }
  if (command === "verify") {
    emit({ digest: verified.digest, harness });
  } else {
    const installed = await createBundleSdk({
      env: process.env,
      runDsh: buildRunDsh(),
      runHermes: buildRunHermes(),
      runPython: buildRunPython(),
      log: line => process.stderr.write(`agent-bundle: ${line}\n`),
    }).install(bundleDir, {
      mode: "persistent",
      force: true,
      ...(options["--home"] === undefined ? {} : { home: options["--home"] }),
      ...(options["--profile"] === undefined ? {} : { profileName: options["--profile"] }),
    });
    const response = {
      digest: installed.digest,
      harness: { ...installed.harness, ...(harness.actualVersion === undefined ? {} : { actualVersion: harness.actualVersion }) },
      home: installed.home,
      profile: installed.profile,
      reused: installed.reused,
      installationId: installed.installationId,
    };
    // Only Pi installations expose a harness config directory. Other harnesses
    // leave codingAgentDir unset, so their JSON stays unchanged.
    if (installed.codingAgentDir !== undefined) response["coding-agent-dir"] = installed.codingAgentDir;
    emit(response);
  }
} catch (error) {
  fail(errorMessage(error));
}

function assertCompatible(actualVersion, versionRange) {
  const actual = valid(actualVersion);
  if (actual === null) fail(`harness version must be valid semver, got ${JSON.stringify(actualVersion)}`);
  const range = validRange(versionRange.replaceAll(",", " "));
  if (range === null) fail(`declared harness version range is not valid semver: ${JSON.stringify(versionRange)}`);
  if (!satisfies(actual, range)) {
    fail(`harness version ${JSON.stringify(actualVersion)} does not satisfy declared range ${JSON.stringify(versionRange)}`);
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function buildRunDsh() {
  let resolved;
  return async (commandArgs, env, runOptions) => {
    if (resolved === undefined) resolved = await resolveDshCommand(process.env);
    await runChild(resolved.command, [...resolved.args, ...commandArgs], { ...process.env, ...resolved.extraEnv, ...env }, runOptions, `dsh ${commandArgs.join(" ")}`);
  };
}

function buildRunHermes() {
  let resolved;
  return async (commandArgs, env, runOptions) => {
    if (resolved === undefined) resolved = await resolveHermesCommand(process.env);
    await runChild(resolved.command, [...resolved.args, ...commandArgs], { ...process.env, ...resolved.extraEnv, ...env }, runOptions, `hermes ${commandArgs.join(" ")}`);
  };
}

function buildRunPython() {
  return async (command, commandArgs, env, runOptions) => {
    await runChild(command, [...commandArgs], { ...process.env, ...env }, runOptions, `${command} ${commandArgs.join(" ")}`);
  };
}

function runChild(command, commandArgs, env, runOptions, label) {
  return new Promise((resolve, reject) => {
    const quiet = runOptions?.quiet === true;
    const child = spawn(command, commandArgs, {
      stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"],
      env,
    });
    if (!quiet) {
      child.stdout?.on("data", chunk => process.stderr.write(chunk));
      child.stderr?.on("data", chunk => process.stderr.write(chunk));
    }
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0 && runOptions?.allowFailure !== true) {
        reject(new Error(`native command failed (exit ${code ?? "signal"}): ${label}`));
        return;
      }
      resolve();
    });
  });
}
