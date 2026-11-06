import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { agentBundleRuntimeFiles, agentBundleVersionProbe, hashRuntimeSource } from "../agentbundle/runtime-files.js";

/** Pinned Hermes Agent version reported by the provisioned runtime. */
export const HERMES_VERSION = "0.21.6";
/** Upstream commit that builds HERMES_VERSION (the host v0.21.6 git install). */
export const HERMES_PIN = "818c13be1dc4fd28987e1e881a9408224afd4535";

export class HermesRuntimeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "HermesRuntimeError";
  }
}

/**
 * Materialize Hermes as a provisioned runtime (aligning the DSH/Pi npm-ci model):
 * clone the pinned commit into <root>/hermes-agent and install the core
 * package into a venv there, so environment: docker no longer depends on a
 * host binary. The vendored agent-bundle SDK (run.mjs + agent-bundle-core) is
 * copied alongside so prepare() can drive the CLI inside the runtime root.
 */
export async function hermesRuntimeInstallation(signal: AbortSignal, network?: import("../../core/contracts/network.js").NetworkAccess): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    throw new HermesRuntimeError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "hermes bundles require a POSIX venv layout; Windows hosts are not supported in this release",
    );
  }
  const files = [...await agentBundleRuntimeFiles(),
    { source: fileURLToPath(new URL("./assets/runner.py", import.meta.url)), target: "hermes/runner.py" }];
  const hash = createHash("sha256").update("hermes-runtime-sdk-1");
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  // v0.21.6 (R8/R9): keep the PM store under the runtime root (HOME={root}) so the provision is
  // self-contained and the .hermes/bin launcher (which bakes the store Python path) stays valid.
  // Pin the index so the pm-runtime sync + plugin workspace re-lock resolve from the mirror (R8),
  // and neutralize the exclude-newer quarantine + re-lock before the first `hermes` probe (R9).
  const provisionEnv = {
    HOME: "{root}",
  };
  const relockMirror = [
    `set -e`,
    `case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS" >&2; exit 1 ;; esac`,
    `case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac`,
    `store="$HOME/.hermes/tools"`,
    `uv_version="0.12.3"`,
    `target="$os-$arch"`,
    `entry="$store/uv-$uv_version-$target"`,
    `uv="$entry/uv"`,
    `case "$target" in`,
    `  linux-x64) tar=uv-x86_64-unknown-linux-gnu.tar.gz; sha=600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101 ;;`,
    `  linux-arm64) tar=uv-aarch64-unknown-linux-gnu.tar.gz; sha=bb66cb52e7b1823aed1183630d8d8e5c958840d584a4c55ec10a4cfc168dcca2 ;;`,
    `  darwin-x64) tar=uv-x86_64-apple-darwin.tar.gz; sha=4c9f52262a14da336e4a42ed24992d12d0c956acde87619e4611d321dffa602b ;;`,
    `  darwin-arm64) tar=uv-aarch64-apple-darwin.tar.gz; sha=546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843 ;;`,
    `  *) echo "unsupported uv target $target" >&2; exit 1 ;;`,
    `esac`,
    `if [ ! -x "$uv" ]; then`,
    `  mkdir -p "$store"`,
    `  tmp="$(mktemp -d "$store/.bootstrap-uv-XXXXXX")"`,
    `  trap 'rm -rf "$tmp"' EXIT`,
    `  archive="$tmp/uv.tar.gz"`,
    `  url="${network?.settings.sources.github.repository ?? "https://github.com"}/astral-sh/uv/releases/download/$uv_version/$tar"`,
    `  curl --retry 3 -fsSL -o "$archive" "$url" || { echo "uv download failed" >&2; exit 1; }`,
    `  got="$( (sha256sum "$archive" 2>/dev/null || shasum -a 256 "$archive") | cut -d' ' -f1 )"`,
    `  [ "$got" = "$sha" ] || { echo "uv sha256 mismatch: got $got" >&2; exit 1; }`,
    `  mkdir -p "$tmp/tree"`,
    `  tar -xzf "$archive" -C "$tmp/tree"`,
    `  inner_count=0`,
    `  for child in "$tmp/tree"/* "$tmp/tree"/.[!.]* "$tmp/tree"/..?*; do`,
    `    [ -e "$child" ] || [ -L "$child" ] || continue`,
    `    inner="$child"`,
    `    inner_count=$((inner_count + 1))`,
    `  done`,
    `  if [ "$inner_count" = 1 ] && [ -d "$inner" ]; then mv "$inner" "$tmp/entry"; else mv "$tmp/tree" "$tmp/entry"; fi`,
    `  rm -rf "$entry"`,
    `  mv "$tmp/entry" "$entry"`,
    `fi`,
    `# R9: neutralize the 14-day exclude-newer (aliyun simple index exposes no upload time)`,
    `sed -i 's/^exclude-newer = "14 days"/# exclude-newer = "14 days"/' pyproject.toml`,
    `sed -i -E 's/= "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"/= false/g' pyproject.toml`,
    `# R8: re-lock uv.lock against the mirror before setup-hermes.sh's frozen sync`,
    `"$uv" lock --index-url="$UV_INDEX_URL"`,
  ].join(`
`);
  const rewriteLauncher = [
    `set -e`,
    `# v0.21.6 has no venv/bin/hermes; setup-hermes.sh bakes ABSOLUTE store-python + checkout paths`,
    `# into .hermes/bin/hermes, which break when the provision staging dir is renamed to the runtime`,
    `# root. Replace it with a location-independent wrapper that execs run-in-hermes-env (R10).`,
    `cat > .hermes/bin/hermes <<'EOF'`,
    `#!/bin/sh`,
    `exec "$(cd "$(dirname "$0")/../.." && pwd)/scripts/run-in-hermes-env" hermes "$@"`,
    `EOF`,
    `chmod +x .hermes/bin/hermes`,
  ].join(`
`);

  const recipe = {
    files,
    commands: [
      { executable: "git", args: ["clone", "--depth", "1", (network?.sourceUrl("https://github.com/NousResearch/hermes-agent.git") ?? "https://github.com/NousResearch/hermes-agent.git")] },
      { executable: "git", args: ["fetch", "--depth", "1", "origin", HERMES_PIN], cwd: "hermes-agent" },
      { executable: "git", args: ["fetch", "--depth", "1", "origin", `refs/tags/v${HERMES_VERSION}:refs/tags/v${HERMES_VERSION}`], cwd: "hermes-agent" },
      { executable: "git", args: ["checkout", "FETCH_HEAD"], cwd: "hermes-agent" },
      { executable: "bash", args: ["-c", relockMirror], cwd: "hermes-agent", env: provisionEnv },
      { executable: "bash", args: ["setup-hermes.sh", "--runtime-only"], cwd: "hermes-agent", env: provisionEnv },
    ],
    probes: [
      { executable: "bash", args: ["scripts/run-in-hermes-env", "hermes", "--version"], cwd: "hermes-agent", env: provisionEnv },
      {
        executable: "bash",
        args: [
          "-c",
          `set -e; out="$(scripts/run-in-hermes-env hermes --version)"; case "$out" in *"${HERMES_VERSION}"*) ;; *) echo "$out" >&2; exit 1;; esac`,
        ],
        cwd: "hermes-agent",
        env: provisionEnv,
      },
      agentBundleVersionProbe(),
      { executable: "bash", args: ["-c", rewriteLauncher], cwd: "hermes-agent", env: provisionEnv },
    ],
  };
  hash.update(HERMES_VERSION);
  hash.update(HERMES_PIN);
  hash.update(canonicalJson({ commands: recipe.commands, probes: recipe.probes }));
  return { ...recipe, id: `hermes:${hash.digest("hex")}`, cacheName: `hermes-${HERMES_VERSION}` };
}
