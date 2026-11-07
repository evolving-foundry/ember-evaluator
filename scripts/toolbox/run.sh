#!/usr/bin/env bash
set -euo pipefail

# Linux Docker host only: Compose bind paths must exist on this same host.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir="$(cd -- "$script_dir/../.." && pwd -P)"
workspace_dir="$(dirname -- "$repo_dir")"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' "Run this script on the Linux Docker host." >&2
  exit 1
fi
if [[ ! -S /var/run/docker.sock ]]; then
  printf '%s\n' "Access to /var/run/docker.sock is required; restricted containers need platform-provided Docker access." >&2
  exit 1
fi
docker --host unix:///var/run/docker.sock info >/dev/null
# The bundled launcher can read YAML before repository dependencies exist.
cd "$repo_dir"
node scripts/network/bootstrap.mjs -- pnpm install --frozen-lockfile
node scripts/network/deployment.mjs toolbox-build

host_pid=""
cleanup() {
  if [[ -n "$host_pid" ]]; then
    kill "$host_pid" 2>/dev/null || true
    wait "$host_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

host_env=()
# The host control process is idle until an authenticated AgentX run requests
# explicit cards. Neither toolbox nor task containers need hardware devices.
if [[ ! -f /.dockerenv && ! -f /run/.containerenv ]] && command -v python3 >/dev/null && command -v npu-smi >/dev/null; then
  mkdir -p "$repo_dir/.scratch"
  host_dir="$(mktemp -d "$repo_dir/.scratch/toolbox-telemetry.XXXXXX")"
  python3 -B -u "$repo_dir/src/runtimes/agentx/assets/host_telemetry.py" \
    --serve "$host_dir/ready.json" > "$host_dir/control.log" 2>&1 &
  host_pid=$!
  for (( attempt=0; attempt<100; attempt++ )); do
    if [[ -f "$host_dir/ready.json" ]]; then break; fi
    if ! kill -0 "$host_pid" 2>/dev/null; then
      printf 'The host sampling control process did not start; see %s\n' "$host_dir/control.log" >&2
      exit 1
    fi
    sleep 0.1
  done
  if [[ ! -f "$host_dir/ready.json" ]]; then
    printf 'The host sampling control process timed out during startup; see %s\n' "$host_dir/control.log" >&2
    exit 1
  fi
  host_address="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "$host_dir/ready.json")"
  host_token="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$host_dir/ready.json")"
  host_env+=(--env "EVALUATOR_HOST_TELEMETRY_ADDRESS=$host_address" --env "EVALUATOR_HOST_TELEMETRY_TOKEN=$host_token")
fi

proxy_env=()
network_file="$(node scripts/network/variables.mjs --path)"
proxy_env+=(--mount "type=bind,source=$network_file,target=/etc/ember/network.yaml,readonly" --env "EVALUATOR_NETWORK_CONFIG=/etc/ember/network.yaml")
network_variables="$(node scripts/network/variables.mjs)"
while IFS= read -r variable; do
  if [[ -n "$variable" ]]; then proxy_env+=(--env "$variable"); fi
done <<< "$network_variables"
for variable in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy HF_ENDPOINT; do
  if [[ -n "${!variable:-}" ]]; then proxy_env+=(--env "$variable"); fi
done

docker --host unix:///var/run/docker.sock run --rm -it --init \
  --name ember-evaluator-toolbox \
  --network host \
  --mount "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock" \
  --mount "type=bind,source=$workspace_dir,target=$workspace_dir" \
  --mount "type=volume,source=ember-evaluator-toolbox-home,target=/toolbox-home" \
  --mount "type=volume,source=ember-evaluator-toolbox-node-modules,target=$repo_dir/node_modules" \
  "${host_env[@]}" "${proxy_env[@]}" \
  --workdir "$repo_dir" \
  ember-evaluator-toolbox:local
