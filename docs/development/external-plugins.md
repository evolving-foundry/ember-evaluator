# 接入外部插件

> [English](./external-plugins.en.md) | 中文

本文从空目录创建独立 TypeScript 项目，实现并编译一个 Metrics 组件，再用实验验证它。要开发其他角色，先在[插件种类](plugins.md#插件种类)选择契约，再把第 2 步的实现和注册替换成自己的组件。Solver 可以按[独立项目中的 Solver](#独立项目中的-solver)照做。单文件 JavaScript 示例见[新增外部插件](add-external-plugin.md)，已有 JavaScript 模块可以直接从第 3 步开始。

外部插件不需要修改 Evaluator 的 `src/plugins/index.ts`。接入分为三个动作：插件在 `apply(ctx)` 中注册组件，命令用 `--patch` 加载插件模块，实验 YAML 按注册名选择组件。只安装包或只写 YAML 都不会自动加载插件。

## 1. 创建独立项目

先按[安装指南](../users/installation.zh-CN.md)安装并构建 Evaluator，使用其 `package.json` 指定的 Node.js 和 pnpm 版本。下面假设目录为：

```text
work/
├── Ember-Evaluator/       # 已构建，包含 dist/index.d.ts 和 dist/cli.js
└── evaluator-metrics/          # 独立插件项目；以下命令均在此目录执行
    ├── package.json
    ├── tsconfig.json
    ├── src/context.ts
    ├── src/index.ts
    ├── cordis.patch.yaml
    └── experiment.yaml
```

新建 `package.json`：

```json
{
  "name": "@example/evaluator-metrics",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "devDependencies": {
    "ember-evaluator": "link:../Ember-Evaluator",
    "@deepseek-ai/cordis": "4.0.2",
    "@types/node": "24.13.5",
    "typescript": "7.0.2"
  }
}
```

`link:` 路径相对插件项目，按实际位置调整。这里从已构建的本地 Evaluator 导入类型，不假定它已发布到公共 npm registry。示例只使用类型导入，所以这些包放在开发依赖；如果插件运行时调用 Evaluator 的导出函数，还需在部署环境提供兼容的 Evaluator 依赖。

保留 `exports.default`：当前插件加载器先使用 `createRequire().resolve()` 定位包，再以 ESM 导入。只声明 `exports.import` 的包可能无法按包名解析。

新建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

## 2. 实现并编译插件

独立项目使用包根导出的组件类型。Cordis 的 `Context` 类型本身没有声明 Evaluator 注入的 `evaluator` 服务。在 `src/context.ts` 声明本例用到的 `register()` 签名，`inject` 会在运行时声明对该服务的依赖。

```ts
import type { Context } from "@deepseek-ai/cordis";
import type { PluginConfigValidator, PluginFactory, PluginRole } from "ember-evaluator";

export type EvaluatorPluginContext = Context & {
  evaluator: {
    register<R extends PluginRole, T>(
      role: R,
      name: string,
      validate: PluginConfigValidator<T>,
      factory: PluginFactory<R, T>,
    ): () => Promise<void>;
  };
};
```

新建 `src/index.ts`，注册一个统计有效评分任务数的指标。

```ts
import type { Metrics } from "ember-evaluator";
import type { EvaluatorPluginContext } from "./context.js";

export const inject = ["evaluator"];

export function apply(ctx: EvaluatorPluginContext): void {
  ctx.evaluator.register(
    "metrics",
    "valid-count",
    (config: unknown) => {
      if (config === null || typeof config !== "object" ||
          Array.isArray(config) || Object.keys(config).length !== 0) {
        throw new TypeError("valid-count does not accept configuration fields");
      }
      return {};
    },
    (): Metrics => ({
      name: "valid-count",
      async compute(snapshot) {
        return {
          valid: snapshot.records.filter(record => record.scoreStatus === "valid").length,
          selected: snapshot.run.taskIds.length,
        };
      },
    }),
  );
}
```

`valid` 表示评分有效的任务数，不是答对数；性能评测的 `scoreStatus` 为 `not-applicable`，不会计入。插件只读取已保存的快照，不需要模型 key，也能用于离线报告重建。

首次安装并构建：

```bash
pnpm install
pnpm build
```

首次安装后提交插件自己的 `pnpm-lock.yaml`，后续安装使用 `pnpm install --frozen-lockfile`。修改 TypeScript 后重新构建；Evaluator 拒绝直接加载 `.ts` 入口。Evaluator 根目录的构建不会自动编译这个独立项目。

其他组件也使用相同的 `register(role, name, validate, factory)`。从包根导入公共类型，不导入 `ember-evaluator/src/...`。`validate` 只校验配置，资源在工厂或运行阶段创建；工厂使用 `runtime.resolvePath()` 解析实验相对路径。持有长连接、临时目录等资源时，在插件作用域注册 `ctx.effect(() => () => resource.close())`；attempt 资源按对应 session 契约释放。详见[组件接口与生命周期](plugins.md)。

### 独立项目中的 Solver

沿用第 1 步的项目结构。把[固定回复 Solver 的实现](add-solver.md#最小示例)保存为独立项目中的 `src/fixed-answer.ts`，将 `Solver` 类型的导入改为 `import type { Solver } from "ember-evaluator"`。将 `src/index.ts` 写成以下入口，并在独立项目中运行 `pnpm build`。

```ts
import type { EvaluatorPluginContext } from "./context.js";
import { createFixedAnswerSolver, parseFixedAnswerConfig } from "./fixed-answer.js";

export const inject = ["evaluator"];

export function apply(ctx: EvaluatorPluginContext): void {
  ctx.evaluator.register("solver", "external-fixed-answer", parseFixedAnswerConfig, createFixedAnswerSolver);
}
```

按第 3 步创建文件方式的 patch，`name` 指向 `./dist/index.js`，`id` 可用 `custom-solver`。将 Solver 示例里的 `experiment.yaml` 和 `gpqa.csv` 保存到独立项目，把 YAML 中的 `benchmark.solver.name` 改为 `external-fixed-answer`，并设置示例中的 `EXAMPLE_SOLVER_KEY`。在独立项目目录执行以下命令。

```bash
ember-evaluator inspect experiment.yaml --patch cordis.patch.yaml
ember-evaluator run experiment.yaml --patch cordis.patch.yaml
```

`inspect` 应显示选中了 `external-fixed-answer`。检查评分和产物时，沿用[固定回复示例](add-solver.md#最小示例)的验收步骤。

## 3. 选择一种模块加载方式

**方式 A：加载本地编译文件。** 新建 `cordis.patch.yaml`：

```yaml
- insert:
    - id: custom-metrics
      name: ./dist/index.js
```

**方式 B：按 package 名称加载。** 当前示例可通过自身 `package.json` 的名称解析，改用以下 patch；不需要同时保留方式 A：

```yaml
- insert:
    - id: custom-metrics
      name: "@example/evaluator-metrics"
```

如果加载的是其他团队提供的包，先在 **patch 所在项目** 安装它及运行依赖，再填写真实包名。例如使用 `pnpm add <插件包名>@<确定版本>`；`@example/evaluator-metrics` 只是本地示例，不是需要从 registry 下载的公开包。将 patch 放在其他实验项目时，也必须保证包能从那个项目解析；只在 Evaluator 仓库或全局安装并不够。

三个名称用途不同：

| 位置 | 本例 | 含义 |
| --- | --- | --- |
| patch 的 `id` | `custom-metrics` | 插件模块标识，用于版本记录；在 patch 中唯一 |
| patch 的 `name` | `./dist/index.js` 或 `@example/evaluator-metrics` | 要导入的模块 |
| `register()` 与实验中的 `name` | `valid-count` | 实验要选择的组件；同一 role 下唯一 |

一个模块可注册多个组件。当前 patch 仅支持 `insert`，条目仅接受 `id`、`name`；不能通过重复注册覆盖内置组件。使用自己的注册名，并在 YAML 中选择它。

## 4. 在实验中选择组件

将下面内容保存为 `experiment.yaml`。先设置 `MODEL_NAME`、`MODEL_ENDPOINT`、`MODEL_API_KEY` 环境变量，方法见[快速开始](../users/quick-start.zh-CN.md)。

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: simpleagent
    service: default
environment: local
scheduler:
  name: local
  concurrency: 1
metrics:
  - name: success-rate
  - name: duration
  - name: usage
  - name: valid-count
    config: {}
run:
  maxTasks: 1
output:
  directory: ./results
```

显式 `metrics` 列表替换默认列表，需要的内置指标也要列出。其他 role 的配置位置如下；这些是字段路径，填写对应的 `{ name, config }`：

| role | 用户 YAML 位置 |
| --- | --- |
| `benchmark` | `benchmark` |
| `solver` / `verifier` | `benchmark.solver` / `benchmark.verifier` |
| `environment` / `scheduler` / `store` / `reporter` | 同名顶层字段 |
| `metrics` | 顶层 `metrics` 列表项 |

Solver 的模型服务通过 `benchmark.solver.service` 选择；需要模型的 Verifier 使用 `benchmark.verifier.service`。配置私有字段写在各自 `config` 中，不放进 patch。需要 Profile 默认组合时，另见[Benchmark 开发指南](benchmarks.md)。

## 5. 验证加载并运行

先按[安装指南](../users/installation.zh-CN.md#安装全局命令)注册 `ember-evaluator`，再在插件项目目录执行：

```bash
ember-evaluator inspect experiment.yaml --patch cordis.patch.yaml
ember-evaluator run experiment.yaml --patch cordis.patch.yaml --dry-run
ember-evaluator run experiment.yaml --patch cordis.patch.yaml
```

- `inspect` 校验实验配置、组件注册名和插件参数，输出展开后的实验配置和脱敏后的网络配置。
- `--dry-run` 还会解析数据来源、枚举并选择题目，可能联网下载数据。它不会调用 Solver，也不会验证指标计算、报告渲染及全部运行时能力。
- 正式运行会调用模型。成功后检查输出 run 目录下 `metrics.json` 的 `metrics.valid-count`，本例选中数应为 1；`valid` 由实际评分状态决定。内置 Markdown 不保证展示任意自定义指标，先以 `metrics.json` 验证结果。

`--patch` 相对当前工作目录；patch 中的文件路径和包解析相对 patch 目录；实验中的 `output.directory` 及工厂用 `resolvePath()` 解析的路径相对实验 YAML 目录。省略 `--patch` 只加载内置插件，不会扫描同目录的 patch。

续跑仍显式传入相同 patch：

```bash
ember-evaluator run experiment.yaml --patch cordis.patch.yaml --resume <run-id>
ember-evaluator report results/<run-id>
```

`report` 不接受 `--patch`，它按已保存的提供者信息加载原来的 Metrics/Reporter 插件，不重新求解。保留原插件安装及可解析路径；移动结果目录不会自动复制插件，也不会自动改写保存的插件路径。

当前本地文件插件只记录入口文件摘要，包名插件优先记录 package 版本；不是完整依赖树的内容校验。不要仅凭版本检查认定所有依赖一致：发布时固定依赖锁，逻辑或资源变化后更新包版本；文件方式可将执行代码打包为单入口，并另行固定外部资源。续跑保留原部署，使用新版本开始新 run。

## 6. SDK 与 Ray 接入

SDK 使用同一套 YAML 和 patch，通过 `patchPath` 显式加载：

```ts
import { Evaluator } from "ember-evaluator";

const result = await new Evaluator().run({
  configPath: "./experiment.yaml",
  patchPath: "./cordis.patch.yaml",
});
```

以上两个路径相对调用进程当前目录。完整的返回值、错误处理及取消用法见[SDK 指南](../users/sdk.zh-CN.md)。

Ray 不会把提交端的插件源码、`node_modules` 或本机 patch 路径自动上传：

1. 提交端、Jobs 协调端和每个执行节点预装兼容的 Evaluator、相同插件构建产物及运行依赖。
2. 各端使用内容一致的 patch，优先用包名或保持相同相对目录结构，避免将提交端绝对路径写入 patch。
3. 执行节点在 `EVALUATOR_NODE_CONFIG` 指定的 JSON 中设置 `pluginPatchPath`；该字段的相对路径以节点配置文件目录为基准。
4. 使用 Ray Jobs 时，协调端额外设置 `EVALUATOR_PLUGIN_PATCH_PATH`，指向容器内预装 patch。提交命令仍需 `--patch`。
5. 插件含缓存目录、Docker 命令路径、容器路径或敏感字段时，注册对应的 `PluginConfigTransport`；具体声明见[插件部署说明](plugins.md#组件配置传到-ray-节点)，准备与调度限制见[并发与环境准备](../users/concurrency.zh-CN.md)。

本地加载成功不等于支持 Ray。插件还需满足远端资源、文件传输、取消和准备能力要求；不能依赖执行节点读取提交端的本机文件。

## 常见错误与验收

| 现象 | 检查方法 |
| --- | --- |
| `unknown ... plugin` | 是否传了 `--patch`；YAML 是否填了组件注册名；`apply` 是否实际注册该 role |
| `must be compiled to JavaScript` | 先构建，将 patch 指向 `.js` / `.mjs`，不要指向 `.ts` |
| 包找不到或 `ERR_PACKAGE_PATH_NOT_EXPORTED` | 从 patch 项目安装包；检查构建产物和 `exports.default` / `require` 条件是否可解析 |
| `duplicate ... registration` | 是否把同一个模块以两种方式加载，或注册名与内置/其他插件冲突 |
| `invalid ... plugin config` | 检查插件自己的 `validate`；私有参数应放在实验 `config` 内 |
| 续跑/节点报告版本不一致 | 恢复原 patch 和插件部署，或用新版本开始新 run；不要绕过校验 |
| 报告重建找不到插件 | 检查原 patch 所在项目、插件构建文件与依赖是否仍可用 |

交付外部插件前，至少检查编译、patch 加载、未知字段拒绝、一次受控运行、结果中的自定义字段和离线报告重建。有资源的插件还要验证失败与取消后的释放；接入 Ray 时单独验证节点部署。可参考仓库已有的独立插件 [DocOps](../../plugins/docops/README.md) 和[插件错误处理](diagnostics.md)。
