# 仓库开发规范

本文件适用于整个仓库。模块调用关系、依赖检查范围和资源所有权见[源码架构与执行流程](docs/development/architecture.md)，文档的目录分工和维护规则见 [docs/AGENTS.md](docs/AGENTS.md)。

## 仓库目录结构

```text
src/
├── index.ts                # 包根公开类型与 API
├── cli.ts                  # 进程入口、信号和退出码
├── cli/                    # 命令参数、终端输出与进度展示
├── application/            # SDK、配置/插件装配、运行、报告、预热、补测与诊断
│   ├── plugins/            # Cordis 注册表、显式插件加载与组件创建
│   ├── retry-control/      # 请求文件事务、认领与 IPC 接入
│   └── ray/                # Jobs、结果下载、worker 装配和进程入口
├── config/                 # YAML/patch 读取、展开、校验和脱敏
├── core/                   # 不依赖具体组件的公共契约和评测流程
│   ├── contracts/          # 八类组件、任务、结果、工厂和配置契约
│   ├── execution/          # run 编排、attempt 执行与队列
│   ├── preparation/        # 准备轮次、依赖物化、时限和验证环境
│   ├── selection/          # 选题、采样
│   ├── recovery/           # 续跑、自动重试与补测资格
│   ├── results/            # manifest、结果判定、来源与版本比较
│   ├── artifacts/          # 文件清单、轨迹写入与产物收集
│   └── …                   # progress、policies、validation、errors
├── plugins/                # 八类 Cordis 组件，各角色入口负责注册
│   ├── benchmarks/
│   │   ├── agent-harness/ # definitions、Harbor 与本类 profiles
│   │   ├── inference-engine/ # AgentX、离线 evidence 与 profiles
│   │   ├── operator/      # Kernel 执行/分析/评分与 profiles
│   │   └── shared/        # 已有跨类别复用的选题准备与来源配置
│   ├── environments/      # local、Docker 准备和会话、共用环境逻辑
│   ├── schedulers/        # local、Ray 与准备队列
│   └── …                  # solvers、verifiers、stores、metrics、reporters
├── runtimes/               # Pi、DSH、AgentBundle、AgentX 等桥接、安装描述与资源
└── infrastructure/         # 进程、Shell、容器、网络、数据、文件、IPC、传输与摘要
    ├── datasets/          # 来源下载、缓存和记录读取；不解析 Harbor 任务语义
    ├── containers/        # Docker 命令、镜像、构建、进程和传输工具
    ├── provenance/        # 包文件扫描和摘要验证
    └── ray/               # Ray 客户端、编码和 Python driver
tests/
├── unit/                   # 配置、算法、契约等单元测试
├── integration/            # 组件协作、CLI、持久化与运行时集成测试
└── fixtures/               # 测试数据、受控插件和可复用环境夹具
playbook/                   # 按 Benchmark 子目录分类的渐进式实验 YAML；临时测试放 .scratch
scripts/                    # 构建、运行时打包等仓库维护脚本
docs/                       # 用户指南、设计、任务与经验记录，分工见 docs/AGENTS.md
└── imgs/                   # 文档引用的图片素材
```

根目录文件及生成目录：

| 路径 | 用途 |
| --- | --- |
| `README.md` | 项目介绍、快速开始与插件使用入口 |
| `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 包信息、命令、本地依赖锁定及 pnpm 配置 |
| `package-lock.json` | 容器运行时 npm ci 的依赖锁；构建时保留为 runtime-lock.json |
| `tsconfig.json` | 全仓库 TypeScript 严格类型检查 |
| `tsconfig.build.json` | 生产代码编译与声明文件输出 |
| `vitest.config.ts` | 默认单元与集成测试 |
| `.gitignore` | 排除依赖、构建产物、缓存和本地实验输出 |
| `dist/` / `node_modules/` | 生成代码与安装依赖，不直接修改或提交 |
| `.scratch/` / `.superpowers/` | 本地临时材料和工具工作文件，不提交 |
| `.cache/` / `results/` / `coverage/` | 本地缓存、默认示例结果和覆盖率输出，不提交；实际结果路径由配置决定 |

公共契约放 `core/contracts`，可替换组件放 `plugins`，运行时安装与桥接放 `runtimes`，共用 I/O 工具放 `infrastructure`。应用层装配配置和插件；application/plugins/load-module.ts 负责插件模块定位、版本读取和导入，open-registry.ts 负责注册表创建与注册。config/plugin-patch.ts 只读取和校验 patch，不导入插件。CLI 处理用户交互。core 只依赖 core；config 不导入 application、plugins、runtimes 或 infrastructure；infrastructure/runtimes/plugins 只能使用 config 中明确列出的纯解析模块。通过 `pnpm check:dependencies` 检查静态、类型、动态导入、再导出及执行循环，违规清单必须为空。核心执行流程不增加按 Benchmark 名称或类别分支的业务逻辑。

## 代码开发规范

### 开发流程

1. **大的功能遵循 design → task → implement → 验收。** 新增重要能力、跨模块重构、共享接口或持久化格式变化，先确认设计和影响范围；已有设计覆盖时直接引用，缺少时新增当日设计，再拆分任务并实施。
2. **任务写清目标、实现路径和验收标准。** 本次实施在新建的当日任务文档记录进展和结果；后续工作新增续篇，不更新之前的文档，不另建重复的 plan、progress、result 文档。
3. **小 bug 和局部改动可以 ad hoc。** 范围清楚、影响有限的修复、文字调整和小重构可以直接修改并验证，不要求每次都创建或更新 `docs` 记录。发现涉及架构或共享契约时再升级为设计与任务流程。
4. **修改前确认当前状态。** 阅读相关实现、契约和已有测试，保留工作区中其他人的修改；避免顺带整理无关文件或扩大改动范围。
5. **按影响范围验证。** 功能和 bug 修复应验证可观察行为，必要时补回归测试；纯文字和格式修改检查内容、链接和示例即可。不要仅为复述实现而增加测试。
6. **交付说明实际结果。** 说明改动、验证命令与结果、剩余限制。未执行的测试和用户负责的手工验收明确标注待验收，不记为通过。影响用户操作的变化同步更新相关指南或 Playbook。

使用 `package.json` 指定的 Node.js 和 pnpm 版本，通过 `pnpm install --frozen-lockfile` 安装本地依赖。Docker 内的 npm 和 `npm ci` 流程保持不变。常用验证命令：

```bash
pnpm check:dependencies
pnpm typecheck
pnpm build
pnpm test --run
```

小改动可以先运行受影响的测试文件；跨模块改动运行默认测试集。临时测试输出放 `.scratch/`，正式且可复用的测试数据放 `tests/fixtures/`。

### TypeScript 代码风格

- 使用 ESM 和现有 `NodeNext` 配置；本地相对导入写 `.js` 扩展名，Node 内置模块使用 `node:` 前缀，纯类型使用 `import type` / `export type`。
- 保持 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等检查，不通过关闭规则规避类型问题。外部输入先用 `unknown` 接收并收窄，避免无依据的 `any`、类型断言和非空断言。
- 使用两个空格缩进、双引号和分号；文件为 UTF-8、LF，并以换行结束。遵循邻近代码，避免把无关格式化混入功能提交。
- 文件名使用 `kebab-case`，变量与函数使用 `camelCase`，类型与类使用 `PascalCase`；固定常量可用 `UPPER_SNAKE_CASE`。名称说明职责，避免含糊缩写。
- 对外接口和协议声明清晰的参数、返回类型；内部局部变量优先使用类型推断。区分字段缺省、`undefined` 和 `null`，遵循现有契约，不随意互换。
- 函数保持单一职责，按模块划分职责；共享逻辑在出现明确复用时抽取，避免为假设的扩展增加抽象。
- 异步工作使用 `async` / `await`；I/O 和长任务遵循接口传递 `AbortSignal`，取消时停止子进程或远端工作。资源通过 `try/finally`、`dispose()` 或 Cordis 生命周期释放。
- 异常包含可定位的上下文，包装异常时保留 `cause`；不吞掉异常或把失败伪装为成功。输出日志、配置、结果和轨迹时不得泄露 API key 等认证信息。
- 使用 `node:path` 处理宿主路径；容器内路径明确使用 POSIX 语义。执行程序优先传独立的 executable / args，不把未经处理的输入拼成 shell 命令。
- 注释解释约束、原因和非显然的边界，不重复代码字面含义。变更公共类型、协议或结果结构时，同时检查序列化、续跑兼容和相关消费者。

### 插件开发规范

- 支持八类组件：`benchmark`、`verifier`、`environment`、`solver`、`metrics`、`reporter`、`store`、`scheduler`。实现对应的 `src/core/contracts/` 契约；第三方插件从包根 `ember-evaluator` 导入公共类型，不依赖未导出的内部路径。
- Cordis 插件声明 `inject = ["evaluator"]`，在 `apply(ctx)` 中通过 `ctx.evaluator.register(role, name, validate, factory)` 注册组件。同一 role 下名称唯一；一个模块可以注册多个组件。
- 插件默认配置通过 `ctx.evaluator.registerProfile()` 注册声明式 Profile，类型从包根导入。Profile 属于配置元数据，不增加执行组件类别；继承、版本和场景由解析层展开，避免在 Loader 或 Engine 中新增按 Benchmark 名称分支的默认值。内置 Harbor Profile YAML 随构建发布并纳入摘要，外部 Profile 随显式 patch 插件发布。
- 配置校验与实例创建分开。`validate` 校验类型、范围和未知字段，并给出明确错误；校验阶段不启动进程、访问模型或分配运行资源。模块导入和注册阶段也不启动评测工作。
- 工厂通过 `(config, runtime)` 获取组件参数、模型和运行时认证，使用 `runtime.resolvePath()` 解析相对实验目录的路径。不要硬编码模型、key、用户目录或机器地址，也不要用全局可变状态串联实验。
- 内置组件在对应角色的 index.ts 注册，Metrics 和 Reporter 分别在 metrics/index.ts 和 reporters/index.ts 注册；Benchmark 在 agent-harness、inference-engine 或 operator 的 index.ts 注册，src/plugins/index.ts 只组合注册入口。外部插件由 run --patch <path> 显式加载，省略参数时不扫描默认文件，--dry-run 也使用相同参数。CLI 的 patch 路径相对当前工作目录解析；patch 的本地 JavaScript 模块路径和 npm 包从 patch 文件目录解析。当前 patch 仅支持 insert，条目使用 id 和 name；TypeScript 入口必须先编译。
- Ray 节点不接收协调端的本机 patch 路径；节点配置通过 EVALUATOR_NODE_CONFIG 的 pluginPatchPath 指向节点本地预装 patch，并以 patch 内容摘要和插件版本校验一致性。Ray Jobs 协调端通过部署环境变量 EVALUATOR_PLUGIN_PATCH_PATH 加载容器内预装 patch。
- 区分 patch 模块标识与组件注册名：patch 的 `id` 用于标识模块，patch 的 `name` 用于定位模块；实验中的 `{ name, config }` 选择组件并提供参数。不要为每个新插件增加专属 CLI 加载逻辑。
- 遵循求解与验证边界：Solver 只接收公开任务和执行环境，不能读取答案、隐藏测试或 verifier 私有材料；Benchmark 负责准备与验证，Scheduler 负责调度，Store 负责持久化，Metrics/Reporter 基于已保存结果工作。
- 运行产物使用契约提供的 attempt 路径和文件清单，保留轨迹、错误及取消状态。Metrics/Reporter 应支持离线重建，不依赖模型 key 或重新执行任务。
- 有资源的组件接入 Cordis effect 或相应的 `dispose` / `close` 生命周期，验证正常完成、失败和取消时都能释放资源。分布式组件不能假定其他节点共享本机文件路径。
- 插件改动检查配置校验、注册加载、契约行为及相关失败路径；涉及持久化或执行时还需检查产物和续跑。保持插件来源、版本记录和 Ray 节点部署一致，不绕过已有版本校验。

可运行的外部插件和 patch 示例见 [插件开发与加载说明](docs/development/plugins.md)，配置细节见 [配置指南](docs/users/config.zh-CN.md)。

## Git Commit 规范

提交信息采用以下格式，方括号内只选一个类型：

```text
[feature] 简短中文说明
[bug] 简短中文说明
[docs] 简短中文说明
```

- `feature`：新增或调整功能；代码重构按实际目的选择 `feature` 或 `bug`。
- `bug`：修复问题。
- `docs`：修改文档。
- message 保持简短，用一行概括主要改动，不展开实施过程或验证细节。
- message 不写作者信息，不添加 `Author`、`Co-authored-by` 或其他署名。
- 每个提交围绕一个明确目的；提交前检查 diff 和暂存区，只提交本次任务相关改动，不覆盖或夹带其他人的工作。
- 依赖变更同步更新 `package.json`、本地 `pnpm-lock.yaml` 和容器运行时 `package-lock.json`；使用 `npm install --package-lock-only --ignore-scripts` 更新容器锁，不用 npm 重装本地依赖。构建会检查容器锁与依赖声明的一致性。不提交 key、真实认证配置、依赖目录、构建产物、缓存或临时测试输出；不强制加入被忽略的临时文件。

示例：

```text
[feature] 支持固定种子的随机采样
[bug] 修复取消任务后的产物收集
[docs] 补充插件开发与加载说明
```

## 文档保留与只新增规则

- `docs/design/` 只保留文档日期距整理日不超过 14 天的设计；`docs/tasks/` 只保留不超过 5 天的任务记录，边界日期保留。按文档日期判断，不用文件修改时间延长保留期；无日期的旧文件以 Git 首次纳入日期为准。
- 同一天的文档分别集中到 `docs/design/YYYY-MM-DD/`、`docs/tasks/YYYY-MM-DD/`；保留独立文件，不将不同主题拼成一篇。新文件使用 `YYYY-MM-DD-<主题>.md` 或 `YYYY-MM-DD-<类型>-<主题>.md`，需要区分时加入当日序号。
- 历史 design/task **只新增，不回改**：后续设计修订、任务进展、验收与纠错新建当日文档，引用前文并说明补充或替代范围；不要把新结论追加到之前的文档，也不要回写其状态或结果。本次新建、尚未交付的记录可在本次工作中完成。
- 保留期清理、日期目录搬迁和必要的链接修正按本规则执行，历史正文不改写。过期文档从工作树移除，历史可从 Git 查询；需要继续引用时使用具体提交的历史链接，不保留失效的本地链接。
- 本规则取代此前“在原设计/原任务中持续追加”的要求；README、导航及 AGENTS.md 等入口与规则文件可按实际结构维护。
