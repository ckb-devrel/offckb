# offckb 工具插件系统：以 Devnet Explorer 为首个案例

状态：**设计讨论稿；Phase 1 的本地接入实验已开始实现，后续设计尚未全部落地。** 初始调研日期：2026-10-28；实现基于 2026-10-29 rebase 后的 `96094c8`。实际可用范围和操作方式见[插件指南](plugins.md)。

## 建议

值得做一个轻量的工具插件系统。offckb 负责提供当前开发链的环境信息、管理安装和启动进程；Explorer 等工具独立发布，负责自己的功能和界面。第一个目标是让一个第三方工具接入后，不再需要修改 `src/cli.ts` 或增加核心依赖。

首版采用 **npm 包 + 静态声明 + 独立子进程**。先用 Explorer 验证协议，再用另一个真实工具检验是否需要更多扩展点。暂不引入 Cordis、通用事件总线、插件互相依赖、热重载或多套 profile，也不迁移现有 Fiber。

如果目标仅仅是提供一个启动 Explorer 的快捷命令，普通子命令就足够；插件机制的收益在于第三方工具可以独立发布，并获得一致的环境信息和生命周期。判断首版是否成功，应看接入第二个工具是否还需要改核心。

## 当前源码告诉我们什么

以下以 offckb `60655db35135ce73106f8ac7c5cfd94e2cc03504` 为基线，没有依赖未接受的 Context。

| 当前证据 | 对设计的影响 |
| --- | --- |
| [`src/cli.ts`](../src/cli.ts) 集中注册 Commander 命令，直接接入 Fiber、debugger 和 TUI | 命令发现可以增加一个明确入口；无需改写整套 CLI |
| [`src/cmd/node.ts`](../src/cmd/node.ts) 显式管理 CKB、miner、proxy、可选 FNN；组合启动时 FNN 退出会触发整体清理 | 新的可选工具不能直接复用“任一组件失败就停止整组”的语义 |
| [`src/fiber/`](../src/fiber/) 已有专门的安装、就绪检查、锁、daemon、状态及清理代码 | 可参考进程身份和清理经验；不要一开始把这些领域逻辑抽成通用框架 |
| [`src/tools/ckb-tui.ts`](../src/tools/ckb-tui.ts) 已处理平台资产、校验和及原子安装 | 二进制分发已有经验，但它不等于第三方命令和服务的扩展协议 |
| [`src/cfg/setting.ts`](../src/cfg/setting.ts) 已统一 RPC、proxy、数据和配置路径 | 插件应接收已解析的环境，避免自己猜端口或读取 settings.json 内部结构 |
| [`src/cmd/devnet-info.ts`](../src/cmd/devnet-info.ts)、[`src/devnet/readiness.ts`](../src/devnet/readiness.ts) 已区分链类型、RPC 就绪与 indexer 就绪 | 可以复用其数据构造逻辑，形成版本化的插件上下文 |
| [`src/scripts/private.ts`](../src/scripts/private.ts) 已根据 genesis 识别 fork 并解析系统脚本 | 插件上下文应保留实际地址前缀和链身份，不能把所有 devnet 都当成普通 `ckt` 链 |
| [`scripts/build.js`](../scripts/build.js) 将 CLI 编译并用 ncc 打包 | 外部插件应从独立安装目录启动，不依赖被打包的动态 import 或核心内部模块路径 |

现有工具说明扩展需求已经出现，但 Fiber 的复杂度不应成为所有插件的入场门槛。

## 从 dsh 借鉴什么

这里的 dsh 指 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。调研固定在 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，避免把快速变化的上游设计当作永久约定。

dsh 的体系包含三个层次：Cordis 提供服务依赖及可撤销的注册；bundle 分发代码和配置；profile 组合 bundle 及用户覆盖层。它用这套机制组合整个产品，适用范围明显大于 offckb 当前的外部工具接入需求。依据：[Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/cordis-primer.md)、[Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/architecture.md)。

| dsh 的设计 | offckb 的取舍 |
| --- | --- |
| 依赖通过服务声明，避免靠偶然的加载顺序 | 首版只提供核心环境协议；Explorer 自己检查 RPC 和 indexer，暂不支持插件依赖插件 |
| 注册和副作用随插件卸载而回收 | 子进程、临时上下文文件由启动它们的命令负责清理 |
| 安装、选择启用和实际激活有不同状态 | 借鉴状态分离原则：包是否存在、命令是否可发现、兼容性诊断分别报告；首版没有 dsh 的配置激活过程，“可启动”也不表示服务已就绪 |
| 配置可预览，失败能定位到插件和原始原因 | 首版在 `plugin list` 提供诊断，独立 doctor 命令按需要增加；错误包含插件版本、执行阶段及日志位置 |
| 包管理委托现成工具 | 使用 npm 安装已发布包，不自建下载器、依赖解析器或注册中心 |
| 版本兼容在导入前检查 | 读取静态声明，检查协议版本和 Node engines 后才启动插件 |
| profile、bundle、配置覆盖、服务容器及 HMR | 暂缓；实际出现多开发环境和插件协作需求后再评估 |

dsh 当前的插件管理已包含锁、兼容性检查、安装后选择 bundle 及失败恢复，不能简单概括成一层 `pnpm add`。offckb 应学它明确报告剩余状态的做法，避免一次复制整个管理体系。依据：[CLI 实现](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/apps/cli/src/plugin.ts)、[Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/boot/plugin-manager/README.md)。

## 实现路径与安装归属

| 路径 | 收益与成本 | 判断 |
| --- | --- | --- |
| 按 PATH 查找 `offckb-<command>` 并转发 | 实现最少，但安装来源、版本、上下文和进程归属难统一 | 可做快捷入口；不足以完成这次期待的集成 |
| 用户自行安装，显式登记包路径，再使用相同的上下文及子进程协议 | 能获得一致集成体验，无需核心先实现安装器；用户自行处理升级和依赖 | Phase 1 采用本地路径验证；它是正式可考虑的简化方案，内置安装器并非插件协议的前提 |
| 静态声明 + 环境协议 + 子进程 | 保留独立 CLI，增加可控的发现、兼容性及生命周期约定 | **推荐** |
| 动态加载 JS 插件并提供 `register(ctx)` | 便于共享 Commander、事件和服务，但会把核心内部 API、模块解析和异常边界变成长期协议 | 等出现必须在进程内协作的需求再考虑 |

子进程主要解决依赖、ESM/CJS 和故障边界；它仍以用户权限执行，**不是安全沙箱**。

用户自装与内置安装器是安装职责的选择，可以共用同一套插件协议。Phase 1 结束后应根据实际安装困难决定是否启动 Phase 2，不能仅因协议可行就认定必须开发安装器。

## 首版用户体验

以下都是拟议接口；插件包名及版本为示意，不代表已发布。

```sh
# 固定版本安装；不改当前项目的 package.json
offckb plugin add @offckb/plugin-explorer@<version>
offckb plugin list

# 在已部署的项目目录中，连接 offckb 当前配置的开发链
offckb node --daemon
offckb explorer --project .

# 也能显式传入多个项目
offckb explorer --project ./project-a --project ./project-b --port 7070

offckb plugin remove explorer
```

`explorer` 在前台运行，Ctrl+C 停止本次启动的 Explorer，CKB daemon 继续运行。首版没有后台 Explorer，也没有自动伴随 `offckb node` 启动；因此移除正在运行的插件应拒绝并提示先退出它。

安装到用户级 offckb 数据目录，调用时以当前工作目录为默认项目。只有显式安装登记的插件参与命令发现，不自动执行当前目录或 PATH 里碰巧出现的插件。第三方包无需使用 `@offckb` scope。

## 最小插件协议

一个包对应一个命令命名空间，子命令和参数由插件自己解析。示意 `package.json`：

```json
{
  "name": "@offckb/plugin-explorer",
  "version": "0.1.0",
  "engines": { "node": ">=22" },
  "offckb": {
    "apiVersion": 1,
    "command": "explorer",
    "entry": "dist/cli.js",
    "description": "Browse the current offckb devnet"
  }
}
```

核心只读取声明，不执行插件代码来取得名称或帮助摘要。`entry` 是包内已构建的 JS 文件，用当前 `process.execPath` 启动，绕过 `.bin`、shell quoting 和额外的 Node 查找；启动前确认其 realpath 在包目录内且为普通文件。首版要求交付可直接运行的包，不在用户安装时编译插件。

`command` 限制为简单名称，禁止覆盖核心命令；两个插件声明相同命令时，安装明确失败，不采用“后装覆盖”。协议版本或 Node engines 不兼容时阻止执行；某个插件损坏仍须允许使用核心命令及 `plugin remove`。

如果 offckb 升级后新增的核心命令与已装插件撞名，发现阶段始终优先注册核心命令，将该插件标记为 `shadowed` 并说明冲突。保留其安装及移除能力，不让冲突导致整个 CLI 启动失败，也不自动改写第三方插件名称。

核心通过 `OFFCKB_PLUGIN_CONTEXT` 指向一个临时 JSON 文件，提供本次命令的只读快照，内容限于：

- `apiVersion`、offckb 版本、当前工作目录、插件专属数据及缓存目录。
- 当前 devnet 的 RPC URL、proxy URL、链类型、genesis hash、实际地址前缀。
- 本地 `list-hashes` 失败时，链身份和脚本降级为未知，并附可选的 `devnet.diagnostic`（固定错误码及脱敏说明）；不需要链的工具仍可运行，需要链的工具自行拒绝未知状态。
- 本次生成的系统脚本 JSON 文件路径；沿用现有导出格式，明确记录格式版本。
- 当前 CLI 的 Node 和入口文件绝对路径，作为必要时调用核心命令的备用方式。
- 输出格式；结构化输出模式必须由适配器遵守，不能直接混入上游的人类日志。

不复制完整 settings、账户私钥或不相关配置。上面的“只读”是协议约定，不构成对同用户进程的文件权限隔离；文件在本次子进程退出后清理。配置中的 RPC 凭据也不能被原样打印到诊断日志。

核心在实际调用时解析上下文；顶层帮助、`plugin list` 只读声明，插件 `--help` 不要求链在线。插件拿到上下文后进行业务所需的就绪检查。所有参数作为 argv 数组转发，并保留调用者 cwd，禁止拼接 shell 命令。

### JSON 输出与参数边界

插件调用时，核心的 `--json` 必须放在插件命令名之前，例如 `offckb --json explorer --project .`。插件名之后的 argv 属于插件，核心不得提升或删除其中的 `--json`；命令边界后的首个 `--` 用作分隔符，消费后剩余 token 原样传递。现有内建命令的标志兼容行为不在本次改动范围内。

这要求先识别插件分派边界，再处理核心前缀，不能直接将整条插件命令交给现有 `normalizeGlobalJsonFlag()`：该函数会扫描并删除所有位置的 `--json`。Phase 1 必须验证重复标志、分隔符、带空格路径和未知插件参数的透传。

在核心选择 JSON 格式且成功启动插件后，**适配器拥有 stdout 的结果记录**：诊断写 stderr，成功时按约定输出一条结果；父进程禁止再执行 `runCli()` 的兜底成功输出，也不因插件退出而补一条成功记录。启动前失败由核心报告，启动后由适配器报告业务错误，父进程保留退出码和必要的进程诊断。帮助请求单独委托，返回后也不补结果记录。首版不通过解析上游人类日志判断 ready。

依据：[`src/cli.ts`](../src/cli.ts) 的 `normalizeGlobalJsonFlag()`、`runCli()`，以及 [`src/util/logger.ts`](../src/util/logger.ts) 的 `result()`/`hasResult()`。父子进程的 logger 状态并不共享，继承同一个 stdout 也无法抑制父进程的兜底输出。

这比让插件 import `src/cfg/setting` 稳定，也不要求插件依赖另一个版本的 `@offckb/cli`。后续可提供少量 TypeScript 类型帮助作者开发，无需先建立运行时 SDK。

### 安装与进程管理的边界

- 每个插件使用独立的安装目录及 npm lockfile；核心只登记命令、包名、精确版本、来源和安装位置，包及依赖的完整性以 npm lockfile 为准，不再维护一份重复的校验清单。Phase 1 直接使用本地路径，正式安装器首版接受固定版本的 registry 包；Git URL、tarball 和任意安装脚本暂缓。
- 包管理调用发生在 offckb 专属目录，使用 `--save-exact --omit=dev --ignore-scripts`。安装脚本被禁用也不代表运行时代码可信；需要安装期构建的包应在发布前完成构建。依据：[npm install 文档](https://docs.npmjs.com/cli/v11/commands/npm-install/)。
- Windows 上不能以为解析到 `npm.cmd` 的绝对路径后就能用 `shell:false` 直接执行。安装器优先验证通过 Node 启动当前 npm 安装的 JS 入口；无法可靠解析时明确失败，不拼接用户输入回退到 shell。该入口的发现规则及带空格路径行为必须通过 Windows 原型验证后才能作为实施依据。依据：[Node 子进程文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)。
- 安装先进入同一数据卷的 staging 目录，再校验静态声明、入口和兼容性。登记更新加锁并原子替换；失败保留原登记及旧版本。不在每次执行时联网更新，也不在 `offckb node` 时自动安装。
- 首版保留防止运行中移除或覆盖的最小互斥记录，因为它支撑上述 remove 语义；不抽象通用 runtime 状态机，也不提供基于持久 PID 的 stop/status。互斥与异常退出后的恢复必须在 Phase 1 原型验证，不能用“Windows 删除文件可能报错”替代跨平台运行保护。完整身份验证及跨进程停止流程留待服务托管阶段。
- 前台启动器负责转发 SIGINT/SIGTERM、等待退出及清理自己创建的进程和临时文件。退出码应反映插件失败；超时终止只针对本次拥有的进程。Windows 进程树清理需要专项验证，不能只靠 POSIX 信号假设。
- 管理命令的 `--json` 由核心输出；插件执行按上节由适配器拥有结果记录，两条路径不得混用。

## Explorer：适合接入，但需要明确适配

固定调研版本：[`477af4400a716353d140fc1a5b8fee8175f74fed`](https://github.com/wildanrhmn/ckb-devnet-explorer/tree/477af4400a716353d140fc1a5b8fee8175f74fed)，包内版本为 `0.2.0`。以下保留初始源码检查结果；当前本地实验的端到端验证及局限见[插件指南](plugins.md)。

| 上游现状 | 接入处理 |
| --- | --- |
| 单个 Node HTTP 服务，提供网页及 JSON API，不需要数据库或独立索引服务 | 保持独立进程及浏览器入口；不需要嵌入 offckb 的终端界面 |
| 需要 Node 22+，使用 tsx 运行 TS；offckb 当前支持 Node 20+ | 只限制 Explorer 插件的运行环境，不为此直接抬高核心要求；Node 20 下给出明确诊断 |
| 已支持 `--rpc`、重复 `--project`、`--port` | 适配器从上下文补上当前 RPC，项目目录保留调用者语义；首版不开放指向任意链的覆盖，避免系统脚本与 RPC 不匹配 |
| `loadSystemScripts()` 从 PATH 调用 `offckb system-scripts -o ...` | 改为优先读取核心传入的系统脚本文件，避免调用到另一版本的 offckb，也避免为单次调用安装 PATH shim |
| 项目脚本从 `<project>/deployment/scripts.json` 加载，启动时读入 | 可直接复用；部署或清链后提示重启 Explorer，首版不增加部署事件总线 |
| 地址编码前缀写死为 `ckt` | 首版仅支持普通本地 devnet，检测到 fork 或无法确认支持的链身份就明确拒绝启动；后续 fork 支持需改用上下文前缀并验证脚本、地址及链切换 |
| 地址、脚本及部分交易查询调用 CKB 内置 indexer | RPC 可达不等于功能全部可用；必须检查 indexer 缺失或落后并说明结果可能不完整 |
| `server.listen(port)` 没有 host 参数，打印 localhost 并不限制监听范围 | 增加 host 参数，正式集成默认显式绑定 `127.0.0.1`；不能声称外层包装已经解决 |

依据：[README](https://github.com/wildanrhmn/ckb-devnet-explorer/blob/477af4400a716353d140fc1a5b8fee8175f74fed/README.md)、[package.json](https://github.com/wildanrhmn/ckb-devnet-explorer/blob/477af4400a716353d140fc1a5b8fee8175f74fed/package.json)、[CLI](https://github.com/wildanrhmn/ckb-devnet-explorer/blob/477af4400a716353d140fc1a5b8fee8175f74fed/src/cli.ts)、[scripts.ts](https://github.com/wildanrhmn/ckb-devnet-explorer/blob/477af4400a716353d140fc1a5b8fee8175f74fed/src/scripts.ts)、[server.ts](https://github.com/wildanrhmn/ckb-devnet-explorer/blob/477af4400a716353d140fc1a5b8fee8175f74fed/src/server.ts)、[explorer.ts](https://github.com/wildanrhmn/ckb-devnet-explorer/blob/477af4400a716353d140fc1a5b8fee8175f74fed/src/explorer.ts)。Node 未指定 host 时的行为见 [Node net 文档](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)。

推荐优先向上游贡献两个小入口：系统脚本文件输入、显式 host；上游仍可保留原 CLI 的默认行为。offckb 的独立适配包负责协议转换和就绪检查。不能承诺现有仓库不改代码就完整符合协议；临时适配分支只用于实验，不能以明确了维护者或固定了 commit 为由继续依赖私有 TS 路径正式分发。

建议职责分配为：offckb 侧维护协议及适配包，Explorer 上游维护业务及 UI。具体维护者尚未确定，也没有获得上游承诺。Phase 1 的命令协议原型先使用最小假插件，不等待上游；本地 Explorer 实验可使用明确标注的临时适配分支。正式分发还必须满足下节门槛，否则保留实验结果、暂缓插件发布。

此外，上游缓存只在 tip 回退时清除，脚本名也在启动时加载。清链或换链后统一重启 Explorer，避免把“tip 没回退”误认为链未变化。支持普通 devnet 的首版也应验证这一场景。

### Explorer 正式分发门禁

这是将 Explorer 实验升级为正式插件的相关 PR 的合并前置条件，不阻断仓库内 Phase 1 协议实验。正式分发必须先确定维护者，并完成以下二选一：

1. 上游合并并发布显式 host、系统脚本文件输入及受 semver 约束的 `startServer` 等公开入口；适配包通过正常包解析使用这些入口。
2. 适配包只调用上游公开 CLI，固定发布版本，并以契约测试覆盖参数、loopback 监听、脚本输入、输出及退出清理。若公开 CLI 尚不能满足这些行为，仍不能毕业。

毕业时删除源码 magic-string replace、私有 `src/*.ts` import、对 tsx export map 内部形状的解析，以及 `OFFCKB_EXPLORER_SOURCE` 实验路径覆盖。不将 `.prototype`、准备脚本或这些私有接入方式包装为正式发布方案。固定 commit 和通过本地冒烟测试不能代替公开兼容契约；保留上述依赖的正式分发 PR 不应合并。

## 分阶段落地

1. **先验证协议，不做安装器。** 先用最小假插件验证 Commander 动态注册、JSON 结果所有权、argv 透传及前台退出，覆盖生产 ncc 包、macOS 和 Windows。再用本地 Explorer 适配验证上下文文件往返、显式 loopback 监听、普通 devnet、fork 拒绝、清链重启和临时文件清理。这两组实验通过才算本阶段完成。
2. **按需要交付最小插件管理。** 实现固定 npm 版本安装、list、remove、命令发现和前台运行；诊断先放进 list，不要求独立 doctor 命令才能交付。开始前先以具名第二工具 `ckb-tui` 做纸面走查：通过 Node 适配器启动原生二进制，核对 TTY、argv、上下文和信号是否足够；这不是承诺迁移现有 status 命令。核心目录预计新增 `src/plugins/` 与 `src/cmd/plugin.ts`，`src/cli.ts` 增加管理命令及统一发现入口。
3. **按实际使用增加服务托管。** 再讨论 `offckb node --with explorer`、插件 start/stop/status/logs 和 daemon。届时增加独立于人类日志的 ready 通道，HTTP 监听成功不等于 CKB 业务就绪；端口冲突及启动超时必须返回可定位的错误。
4. **有第二个真实案例再抽象。** 优先选择另一个外部工具验证协议；Fiber 作为较晚迁移对象，保留现有命令兼容性与 fork 限制。只有出现插件间协作或多环境复用需求，再引入服务依赖、profiles 或 bundle。

组合服务阶段必须明确所有权：连接已有 CKB 的插件命令不能关闭 CKB；同一个 node 管理器启动的插件随它清理；独立启动的插件由自己的管理器停止。可选 Explorer 失败只降级并报告，核心 CKB/miner 失败触发所拥有组件的反向清理；如以后提供 required 模式，再显式约定整体失败。现有 `--fiber` 行为保持到专门迁移时再讨论。

## Kimi 独立评审回应

Sentinel 使用 `kimi-coding/kimi-for-coding` 做了只读评审，认为选型及分期合理，提出 M1–M4 等问题。评审核对了本地源码，未独立复核 dsh 和 Explorer 外部仓库；这些意见是协作材料，不构成人类验收或接受的 Context。

- **M1，输出所有权：** 已补适配器拥有结果、父进程抑制兜底及标志边界；命令回归测试及生产 ncc 包冒烟已验证这些边界。
- **M2，升级撞名：** 已补核心优先、插件 `shadowed` 及保留移除能力。
- **M3，Windows npm：** 采纳必须验证的风险，纠正“npm.cmd 绝对路径 + shell:false 即可”的修法；当前 npm JS 入口解析及跨平台实测仍未完成。
- **M4，维护归属：** 已提出职责及正式分发门禁；具体维护者与公开兼容契约未定，不能视为已关闭。
- **S1/S2，复杂度：** 保留支撑“运行中不可移除”的最小互斥，通用运行状态机推迟；完整性复用 npm lockfile，不另建清单。
- **第二工具与验证次序：** Phase 2 前以 `ckb-tui` 走查；按命令协议、Explorer 上下文往返、安装器跨平台的顺序验证。

## 实施时的验收点与未决项

- 未登记插件时，核心启动不加载插件代码，也不为插件创建 registry 或发起 RPC；命令发现允许只读探测 `registry.json` 是否存在。新增一个合规插件不用修改核心命令源码。
- 在打包后的 CLI、带空格的路径、macOS/Linux/Windows 验证命令发现、argv、cwd、Node 版本检查、信号退出及清理。
- 损坏声明、重复命令、升级后核心撞名、路径越界、并发安装/移除、安装中断和运行中移除都能明确处理；旧版本仍可使用，核心帮助和移除命令仍可运行。
- 自定义 RPC 端口、多个项目、空 deployment、错误 JSON、端口占用、RPC 离线、indexer 缺失/落后、清链重启和 `--json` 输出均有覆盖。
- Node 20 仍能使用 offckb 核心；Explorer 明确拒绝不满足 engines 的运行环境。普通 devnet 通过后，再单独验证 mainnet/testnet fork，不能依据 HTTP 能打开就宣布支持。
- 未决：确认适配包维护者、上游入口及分发方式；验证当前 npm JS 入口的可靠发现、禁用安装脚本后的交付形态、最小运行互斥和 Windows 进程清理；以 `ckb-tui` 检验协议适用性。以上事项尚未因文档修订而获得验证。

侧聊审查补充：本地元数据失败已改为降级，重复 `runCli()` 的命令刷新有回归测试。Phase 2 再评估失效租约恢复与自定义 binary 的 RPC 链身份探测：仅有持久 PID 的存活检查不能证明进程身份或子进程组已退出，不能直接据此删除互斥记录，更不能向该 PID 发信号。当前人工确认后清理的限制保留。现有 Windows CI 的普通子进程测试通过，但信号测试跳过了 Windows；真实 `taskkill /T /F`、父命令退出、后代清理及中断状态的专项验证仍是 Phase 1 未闭环项，不能用三平台 CI 全绿代替。本文不构成阶段签收。

以上保留整体设计与后续验收标准，不表示它们已经全部通过。第一阶段实现采用显式本地 link/list/unlink；registry 安装、后台服务与正式 Explorer 分发仍未交付。实现及验证方式见[插件指南](plugins.md)。
