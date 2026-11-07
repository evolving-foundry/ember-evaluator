# Benchmark Requirements and Acceptance Guide

> English | [中文](./benchmark-evaluation-requirements.md)

For dataset integrators and experiment reviewers: prerequisites, configuration, and verifying official requirements. Deliverables are task specifications, experiment YAML, and real-run acceptance results.

Covers pinned sources, official images, platforms, per-task resources/timeouts, public/private materials, delivery, scoring, and acceptance. Current implementation defines fields/limits; sample budgets illustrate locations. Formal evaluation uses official requirements and records actual measurements.

See [installation](../users/installation.md) for dependencies and [configuration](../users/config.md) for components. If existing components cannot express requirements, use [benchmark development](benchmarks.en.md) for interfaces/registration/lifecycles/regression tests.

## 1. Choose an Integration Approach

| Dataset | Approach | Work |
| --- | --- | --- |
| Record QA/multiple choice/text generation | Existing component or plugin adaptation | Record format, fields, splits, official scoring |
| instruction.md/task.toml/environments/test entries | Generic Harbor; profiles for defaults | Pin sources, IDs, images/resources/reward mappings |
| Special environments/state/protocols | Plugin development, then this acceptance | List unsupported requirements/expected behavior |

Download platforms do not determine approach: HF can serve records or Harbor packages. Configure existing protocols when sufficient.

Definition/Source/full protocols are code choices only; see [implementation locations](benchmarks.en.md#choose-an-implementation-location). Integrators must still specify environments/scoring rather than merely requesting a plugin.

## 2. Complete Task Specifications First

Record official requirements and actual values separately, explaining differences. For heterogeneous datasets, specify tasks/classes rather than averages.

| Item | Required detail |
| --- | --- |
| Identity/scope | Version, commit/archive digest, split, IDs/count/exclusions |
| Public input | Prompts/files/tools/skills/MCP/services |
| Private materials | Answers/hidden tests/judge rules/credentials |
| Images | Official solve/verify images, repositories/versions/digests/platforms/auth |
| Platforms | Separate solve/verify OS/architecture, emulation policy, native/system dependencies |
| Solve resources | CPU/memory/temp storage/GPU/NPU/sidecars |
| Verify resources | shared/separate, CPU/memory/storage/dependencies, not assumed equal |
| Time budgets | Preparation/solve/verify/collect/whole attempt |
| Networking | Source/build/solve/verify services/domains |
| Delivery | Text/files/workspace/Git patch/measurements, paths/missing handling |
| Scoring | Main score/correctness/sentinels/judges/denominators/invalid handling |
| Recovery/cost | Source checks/cancellation/cleanup/resume/rate limits/tokens/cost |

Separate official requirements, available node resources, and enforced limits. `storage: 16g` is a declaration, not proof of an isolated16 GiB quota.

## 3. Pin Sources and Task Identity

- GitHub requires full40-character commits, not movable branches/tags as identity.
- HTTP archives pin URL/SHA-256/root without credentials in URLs/locks.
- Local directories suit single-machine checks; Harbor local sources do not support Ray. Distributed nodes must independently materialize pinned sources.
- IDs must be unique/stable. Order-derived IDs require pinned files/partitions/conversion order; verify selection matches execution.
- Locks retain versions/digests and reject source changes on resume; old results cannot describe new tasks.
- Check counts/splits/duplicates/broken tasks/exclusions with traceable reasons, never silent skips.
- For unsupported formats provide original samples, format descriptions, and content-pinning requirements.

See [Harbor sources](../users/benchmarks/harbor.md) for archives/GitHub/local syntax.

## 4. Prefer Official Images to Dockerfiles

### 4.1 Selection Principles

Check upstream version-matched official solve/verify/sidecar images first. Declare available images in tasks/explicit data mappings; use supported Dockerfile/Compose builds only without image declarations.

Official means benchmark-published task environments, not arbitrary language bases. Record provenance/task version/repository/platform/digest, preferring digest pins. Distinguish multi-platform index and single-platform manifest digests; references must include target platforms.

Framework does not search/guess official images. Nonstandard manifests require explicit environment mappings and validation.

### 4.2 Current Harbor Order

| Environment | Priority |
| --- | --- |
| Solve main | `environment.docker_image` → Compose `main.image` → `main.build` → `environment/Dockerfile` |
| Separate verify main | `verifier.environment.docker_image` → private Compose `main.image` → `main.build` → `tests/Dockerfile`; without private definitions reuse solve definitions |
| Sidecars | service `image` → `build` |

When both image/build exist, image wins. Explicit main images retain sidecars/dependencies/healthchecks.

Reuse platform-compatible local images before pulling; preference does not force redownload. Pull/auth/platform failures remain errors without build fallback. Builds apply only when images are undeclared.

Evaluator/Solver runtime layers may still be built on official images without rebuilding task Dockerfiles. Shared preparation validates identities; attempts must not reselect/pull different sources.

### 4.3 Image Checks

- Check solve and verification separately.
- Confirm platforms/shell/system libraries/runtime dependencies.
- Private pull credentials must exist on each node, excluded from public tasks/results.
- Solve images/public contexts contain no answers/hidden tests/judge credentials.
- Dedicated Harbor shell images contain `/tests/test.sh` without upload overwrite. Shared/fallback receives tests at verification.
- Validate cold pulls and warm reuse, recording actual identities.

## 5. Platforms and Native Execution

### 5.1 Declare Task Platforms

Docker supports linux/amd64/linux/arm64; Harbor `environment.os` supports `linux` only. Report Windows/other OS/architecture blockers before integration; they are not supported by assumption.

Harbor declarations:

```toml
[environment]
os = "linux"
platform = "linux/amd64"
```

Separate verification inherits platform by default or declares verifier.environment.platform. Check both phases.

YAML may supply omitted platforms and prohibit emulation:

```yaml
environment:
  name: docker
  platform: linux/amd64
  config:
    allowEmulation: false
```

Priority: **task declaration → experiment `environment.platform` → daemon native**. YAML cannot override task platforms. `auto` is Docker selection, not a task requirement.

Determine actual worker-daemon platforms, not CLI Windows/WSL/coordinator OS. Every Ray node must comply.

### 5.2 Cross-Architecture and Other Requirements

Existing QEMU detection/use is allowed by default; framework installs none. Emulation alters builds/timing and may introduce timeouts; it is not native performance. Prefer native nodes/allowEmulation:false for time/throughput comparisons.

Architecture alone omits distro/glibc-musl/Python-Node-JDK/extensions/browser/ISA/kernel/permissions/case/symlinks/systemd/privileged/socket requirements. Pull success does not prove executable tasks.

Not all requirements have fields; validate individually in real runs and report unsupported backends. Multi-container tasks need Composev2; solvers receive no Docker socket. See [FAQ](../users/faq/README.md).

## 6. Per-Task Resources and Concurrency

### 6.1 Declare Solve and Verification Separately

Harbor solve resources example:

```toml
[environment]
cpus = 2
memory = "4g"
storage = "16g"
```

| Resource | Current enforcement | Integration requirement |
| --- | --- | --- |
| CPU | `--cpus` plus checked cpuset/visibility | Quota/affinity, not exclusive cores; fractional quota differs from visible count |
| Memory | `--memory` | Include agents/tools/compilers/tests/children; measure peaks |
| Storage | Declaration with `storage.enforced: false` | No reservation/write cap; deployment/monitoring must provide capacity |
| GPU/NPU | Incomplete device/memory/driver support; Harbor rejects GPUs | `gpus: 1` alone is insufficient; no silent CPU fallback; assess backend/scheduling/contracts first |

Harbor environment/verifier.environment accepts `cpus`,memory/memory_mb,storage/storage_mb. Do not specify both forms in one section. Use supported units such as4g/4096m.

Separate verification inherits resources/platform and may override. shared uses one container; different quotas/environments require separate plus delivery acceptance, not a conflicting independent declaration.

Docker checks each environment against host total CPU/memory, not aggregate concurrent reservations. Local lacks equivalent isolation/guarantees.

### 6.2 Estimate Peak Capacity

For similar tasks with sequential solve/verify and no sidecars, estimate:

```text
CPU concurrency cap ~= available CPU / max(task solve CPU, task verify CPU)
Memory concurrency cap ~= available memory / max(task solve memory, task verify memory)
```

Use the smaller capacity with headroom for OS/coordinator/Docker/preparation. Heterogeneous combinations/sidecars need actual sums; schedulers do not automatically reduce concurrency for large tasks. Builds have separate overhead; runtime limits do not cap builds.

Peak disk includes data/extraction caches, layers/build cache, active workspaces, artifact packaging, restored verification copies, and history. `concurrency × storage` is not total node disk demand.

Ray currently requests1 CPU+1evaluator_slot per task, without resource-weighted scheduling. Set node slots/concurrency from measured requirements and preparation.concurrency separately. See [Ray](../users/config.md#ray-and-execution-nodes)/[capacity](../users/concurrency.md#capacity-and-limitations).

## 7. Budgets and Timeout Outcomes

### 7.1 Separate Budgets

| Time item | Field | Meaning/default |
| --- | --- | --- |
| Whole attempt | `run.timeoutSeconds` | Execution budget per attempt, default 7200/profile override; not whole experiment |
| Solve | `run.solveTimeoutSeconds` then agent.timeout_sec | Starts at solve; absent means only whole-attempt cap |
| Verify | `run.verifyTimeoutSeconds` then verifier.timeout_sec | Starts at verify; absent means only whole-attempt cap |
| Early preparation | Environment build_timeout_sec/run.preparation | Base×min(node effective concurrency,10), no default round cap |
| Collect commands | verifier.collect timeout_sec | Per command, default 60 seconds, also outer-phase bound |
| Cleanup | No ordinary YAML option | Independent bounded cleanup; may finish after attempt deadline; inspect status |

Phase/attempt clocks: whichever expires first applies. Budgets should satisfy:

```text
attempt budget >= environment startup and Solver preparation + solving + phase transitions
                 + collection/transfer + verification startup + verification + headroom
```

For solve1800/verify300, initially allow attempt2400 and refine from measured overhead. Attempt1800 cannot also guarantee full300 verification.

Shell verification includes test upload/script/reward reads, not just `test.sh` runtime. Container startup/artifact restore outside verify also need attempt headroom.

### 7.2 Harbor Preparation Budgets

Solve/separate verification retain independent build declarations, falling back to defaults.buildTimeoutSeconds. `PreparedTask.preparationTimeoutSeconds` stores bases; plan preparation.defaultTimeoutSeconds stores defaults; schedulers supply node effective concurrency. Each phase multiplies its base by `min(C, 10)`, excluding queueing and without taking a dataset-wide maximum.

Early preparation is outside task execution. No default round cap. [Configuration](../users/config.md#environment-preparation-timeouts) owns overrides/round caps/pipeline busy-time/old-field migration. Extended preparation does not change solve/scoring/classification.

### 7.3 Valid Zeros Versus Failures

| Outcome | Handling |
| --- | --- |
| Normal solve/verify, official zero | Valid zero |
| Recognized quality agent timeout | `agent_timeout`,valid zero; no normal verification, retain evidence where possible |
| Preparation/startup/verification timeout | Failure, not ordinary wrong-answer zero |
| User cancellation | Cancelled, not zero |
| Performance timeout | Infrastructure failure, not quality timeout zero |
| Collection/cleanup after valid scoring | Scores may survive; evidence/cleanup remain separate, no release claims |

Ordinary deadlines are not automatic network recovery. Explicit evidence follows [network rules](../users/network-retry.md). New attempts can receive fresh budgets; total time/cost is separate.

Cancellation acceptance checks actual stopped processes/containers/writes, not just returned CLI. Avoid reusing occupied resources before confirmed cleanup. See [lifecycle requirements](benchmarks.en.md#lifecycle-and-resource-ownership).

## 8. Public Inputs, Networking, and Delivery

### 8.1 Public and Private Materials

Agents receive only public tasks/allowed environments. Keep answers/hidden tests/private grading out of prompts/structured inputs/files/skills/solve images/public contexts. Omitting answers from prompts does not prevent filesystem access.

Model/judge credentials use service bindings. Harbor shell judge secrets enter verification scripts only, never descriptions/solve environments. Redact results/locks/trajectories/diagnostics.

### 8.2 Phase Networking

Check source/build-install/agent/verifier access separately. Harbor baseline environment is overridden by agent/verifier; separate verification may have its own baseline.

- Solve `no-network` retains controlled model gateways; offline verification has none.
- Allowlists support HTTP/HTTPS domains within current scope, not arbitrary TCP/UDP/IP/CIDR/ports/paths; exact domains exclude subdomains.
- Build/install networking is independent of solve allowlists.
- Compose needs supported bridge combinations; incompatible isolation cannot silently degrade.
- Verify actual node model/judge/MCP access; coordinator `localhost` is not a node service address.

See [Harbor networking/delivery](../users/benchmarks/harbor.md#network-policies).

### 8.3 Shared and Separate

| Mode | Behavior | Checks |
| --- | --- | --- |
| shared | Retain solve filesystem and verify there; default without separate declarations | Stop solve writes before private test injection; background services not guaranteed |
| separate | Export state, confirm solve cleanup, create/restore verification | All needed files export/restore without local absolute paths/implicit shared disks |

Harbor uses nonoverlapping absolute container file/directory paths with exclusions/sidecar sources, without arbitrary destination remapping. Confirm protocol support for workspaces/Git patches rather than inventing Harbor fields.

Ordinary missing artifacts retain manifests/ARTIFACT_COLLECTION_INCOMPLETE warnings and continue official scoring. Permissions/transfers/digests/path-safety failures abort. Fabricated files or treating transfer failure as ordinary absence are invalid.

## 9. Verify Official Scoring and Result Definitions

Use official entry/rewards. Shell prefers `/logs/verifier/reward.json` then `reward.txt`; main rewards must be finite. Missing/malformed/sentinel rewards fail verification rather than hide as zero. Nonzero script exits with valid rewards retain both exit/reward.

Before acceptance, verify known outputs against:

- Main reward key, dimensions, official thresholds/sentinels.
- Separate valid zero, unmeasured score, and verification failure; no missing→zero.
- Continuous-only scores require no invented accuracy thresholds. Performance checks load/completeness/throughput/latency without accuracy.
- Denominators for valid/agent-timeout/infrastructure/excluded tasks; never inflate by dropping failures.
- Fixed judge versions/bindings/budgets/networking; offline reports reuse evidence without calls.

For new scoring/formats, see [scores/diagnostics](benchmarks.en.md#scores-and-diagnostic-evidence).

## 10. Harbor Configuration Example

Example package:

```text
my-benchmark/
└── tasks/
    └── task-001/
        ├── instruction.md
        ├── task.toml
        └── tests/
            └── test.sh
```

Official images below replace `environment/Dockerfile` builds. **Image addresses/digests are placeholders; replace with real official target-compatible references and verify time/resources too.**

`task.toml`：

```toml
version = "1.0"
artifacts = ["/workspace/output"]

[task]
name = "task-001"

[environment]
docker_image = "registry.example.org/official/task-001@sha256:<64-character-digest>"
os = "linux"
platform = "linux/amd64"
workdir = "/workspace"
cpus = 2
memory = "4g"
storage = "16g"
build_timeout_sec = 1200

[agent]
timeout_sec = 1800
network_mode = "no-network"

[verifier]
timeout_sec = 300
environment_mode = "separate"
network_mode = "no-network"

[verifier.environment]
docker_image = "registry.example.org/official/task-001-verifier@sha256:<64-character-digest>"
platform = "linux/amd64"
cpus = 2
memory = "8g"
storage = "16g"
build_timeout_sec = 1200
```

The verification image must contain `/tests/test.sh`; task packages still supply it for preparation checks. Both must match the pinned version. Agents must actually create/write declared output paths.

Without dedicated verify images, omit `verifier.environment.docker_image` and use private builds/fallback from section4, checking test delivery. Without solve images, provide public environment/Dockerfile.

`experiment.yaml` beside `my-benchmark/`:

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark:
  name: harbor
  config:
    dataset: my-benchmark@1.0
    source:
      kind: local
      path: ./my-benchmark
    tasks:
      root: tasks
      id: task.name
      expectedCount: 1
    defaults:
      workdir: /workspace
      buildTimeoutSeconds: 1200
    scoring:
      primary: reward
      passThreshold: 1
      errorValues: [-1]
  solver:
    name: simpleagent
    service: default
  verifier:
    name: harbor-shell

environment:
  name: docker
  platform: linux/amd64
  config:
    allowEmulation: false

scheduler:
  name: local
  concurrency: 1

run:
  timeoutSeconds: 2400
  verifyTimeoutSeconds: 300
  onError: continue

output:
  directory: ./results/my-benchmark
```

Paths use the YAML directory. For Ray, replace local sources and check node images/source/access credentials. See [implementation examples](benchmarks.en.md#three-runnable-integration-examples) for plugin code/controlled tests.

## 11. Staged Acceptance

After installation/build, run from the repository root with actual paths:

```bash
ember-evaluator inspect experiment.yaml
ember-evaluator doctor experiment.yaml
ember-evaluator run experiment.yaml --dry-run
ember-evaluator run experiment.yaml
ember-evaluator report <run-dir>
```

Use identical --patch for checks/execution. Offline reports use saved provenance without patches. `doctor` runs download/build probes without calling models; dry-run is not runtime acceptance.

| Check | Pass criteria |
| --- | --- |
| Effective config | Sources/versions/platforms/Solver/verifier/budgets/concurrency match requirements |
| Official images | Declared image used; replaced Dockerfiles not built; pull errors retained |
| Cold/warm startup | Both finish with inspectable identities/platforms |
| Platform boundaries | Native success; forbidden cross-architecture fails; emulated results labeled |
| Resources | Measured solve/verify/sidecar peaks, enforced CPU/memory, storage not mistaken for quota |
| Positive/zero scoring | Known correct/incorrect outputs match official rewards/reports |
| Timeout/cancellation | Distinct solve/verify/preparation/cancel states; actual work stops |
| Public/private | Agents cannot access answers/hidden tests/private images/judge secrets |
| File delivery | Complete required state, ordinary absence distinct from transfer failure |
| Failure evidence | Clear diagnostics for missing/invalid rewards, images/platforms/resources |
| Concurrency | Increase from1, measure resources/rate limits/disk/preparation |
| Resume | Matching identity recovers; source changes reject; failures follow policies |
| Offline reporting | Rebuild without model/judge calls |
| Ray | Independent materialization/pulls/platforms/plugins/auth/slots validated |

Label static checks, controlled tests, real runs, failures, skips, pending acceptance separately. Plugin regression does not replace real acceptance. See [regression tests](benchmarks.en.md#plugin-regression-tests).

## 12. Deliverables

- Pinned sources/scope/locks/exclusion reasons.
- Official image provenance/references/actual IDs, solve/verify platforms, native/emulated records.
- Per-task resources/timeouts/preparation budgets/verified concurrency.
- Runnable YAML and any plugin/profile/patch/version metadata.
- Public/private/network/artifact/scoring documentation.
- Acceptance records, offline-rebuildable results, unsupported/unverified conditions.

[Development documentation](README.en.md) · [Benchmark development](benchmarks.en.md) · [Harbor guide](../users/benchmarks/harbor.md)
