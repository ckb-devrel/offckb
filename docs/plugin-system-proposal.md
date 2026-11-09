# offckb 工具插件协议与宿主边界

状态：**实现草案，供代码审阅；不构成人类验收或接受的 Context。** 实际操作、字段和平台限制见[插件指南](plugins.md)。

## 目标与归属

让第三方工具在不修改 offckb 核心源码的情况下，获得当前开发环境、注册独立命令并受控运行。核心负责发现、兼容检查、授权、环境快照和前台生命周期；插件作者负责自己的功能、依赖、界面、就绪判断和发布。

所有实际应用插件地位相同，均应独立维护和发布。宿主不内置首选插件，不固定某个应用的包名、版本、参数或链支持策略，也不把它的上游发布作为宿主交付门槛。本 PR 只保留协议探针和合成测试；实际适配包及其业务端到端测试放在独立插件仓库。

采用 **npm 包形态 + 静态声明 + 独立子进程**。默认使用 OS 沙箱，也允许用户显式信任单个包后原生执行，方便 Windows 用户无需 WSL 使用插件。先验证本地接入与清晰的运行边界，不引入 Cordis DI、事件总线、热重载、profile、bundle 或插件间依赖，不迁移现有核心工具命令。

## 借鉴 dsh 的边界

调研基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。它通过 Cordis 服务依赖、bundle 分发及 profile 组合配置来组织整个产品，需求范围大于当前外部工具接入。

| 借鉴点 | 当前实现 |
| --- | --- |
| 声明与运行分离 | 发现阶段只读 package.json，不执行插件取得名称和摘要 |
| 安装、可发现、兼容与运行状态分离 | install 托管安装，link 支持本地开发；list 报告声明、兼容及撞名问题；实际就绪由插件负责 |
| 副作用随卸载或退出回收 | 当前调用拥有子进程、网关和临时文件；不提供跨进程 stop 或后台服务 |
| 使用成熟包管理工具 | 使用固定 npm CLI 处理 npm/GitHub 来源和依赖，不自建下载/依赖解析系统 |
| 兼容前置检查 | 执行前检查协议、入口路径、Node engines 和显式授权 |
| 服务容器、profile、bundle、HMR | 等多个真实插件提出共同需求后再评估 |

依据：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/architecture.md)、[插件 CLI](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/apps/cli/src/plugin.ts)、[Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/boot/plugin-manager/README.md)。这些参考不意味着复刻其完整生命周期或配置模型。

## 包与安装

一个包对应一个简单命令命名空间；子命令由插件自行解析。

```json
{
  "name": "my-offckb-tool",
  "version": "0.1.0",
  "engines": { "node": ">=20" },
  "offckb": {
    "apiVersion": 1,
    "command": "my-tool",
    "entry": "dist/cli.mjs",
    "description": "Inspect the current development environment",
    "permissions": ["devnet-read"]
  }
}
```

`entry` 必须是包内普通、已构建的 JS 文件，其 realpath 不得越界。宿主读取静态声明并用当前 Node 启动独立进程，不把插件 import 进 ncc 核心包。

提供 `plugin install <npm-package|github:owner/repo[#ref]>` 一步安装并登记，接受 npm 版本/range/tag 和 GitHub HTTPS URL。用户无需手动 clone、npm install 或 link。GitHub 仓库根目录必须符合插件包协议；安装到专属托管目录，npm 版本及 GitHub commit 明确记录，依赖锁定使用 npm lockfile，不另建完整性登记系统。

再次 install 同名托管包会在独立目录准备，校验成功且旧插件已停止后原子切换登记，再删除旧包；提交前失败保留旧登记及代码；登记原子切换后立即转移新目录归属，锁、临时文件及旧包的后置清理异常只报告诊断，不删除已登记的新包。不同包抢占命令或覆盖用户手动 link 的目录均拒绝。`plugin remove` 删除托管包并解除登记，保留 data/cache；对于本地 link 仅解除登记。`link/unlink` 保留用于开发，relink 托管包不会丢失归属记录。自动更新、任意 tarball/本地/SSH 安装源和服务托管不在当前范围。

默认禁用安装脚本，`--trust` 仅选择可信运行，不自动允许构建。源码插件可通过 npm 标准 `prepare` hook 构建；用户显式提供 `--trust --allow-scripts` 后，安装及依赖脚本才可在当前用户权限下执行。该阶段在运行沙箱之外，失败回滚无法撤销脚本写到安装目录外的副作用；不猜测任意仓库的构建步骤。

随 offckb 提供固定 npm 11.21.1 CLI（optional dependency），通过 Node + npm-cli.js 启动，避免 Windows npm.cmd shell 问题及 npm 10 对 Git prepare 的 ignore-scripts 缺口。安装器要求 Node 20.17+（20.x）或 22.9+；GitHub 来源需要 Git。核心命令及本地插件执行维持各自要求。安装输出写 stderr，保留宿主一条 JSON result；下载/构建有超时和中断清理。

核心命令优先。重复插件名明确失败；升级后核心新增同名命令时，插件标为 `shadowed`，保留移除能力。损坏登记或声明不应阻断核心命令，也不应被发现流程自动覆盖。

## 环境与参数协议

`OFFCKB_PLUGIN_CONTEXT` 指向本次临时 JSON，包含 API/offckb 版本、调用目录、输出格式、插件专属 data/cache 目录、链身份及系统脚本快照。data/cache 以完整包名的 SHA-256 为稳定目录键，跨版本及安装保留，不按命令或 installation.id 分配；不同包复用命令不会继承数据，旧实验的命令目录不自动认领。包名是本地命名空间，不是发布者身份认证。不会复制完整 settings 或账户私钥。字段详情以[插件指南](plugins.md#context-and-output)为准。

- 无 `devnet-read` 授权时 RPC 字段为空；有授权时只暴露宿主只读网关，原始 URL 和认证留在宿主。
- 链元数据由托管 CKB 本地 `list-hashes` 提供，限时三秒；缺失或失败降级为 `unknown`，必要时附脱敏诊断。需要链身份的插件自行决定是否拒绝，并验证 RPC genesis。
- 沙箱模式下 `project-deployment` 授予调用项目 deployment 的只读访问；额外路径用 `--read` 显式授权。可信模式具有用户自身的文件权限，不能把这些声明宣传为访问上限。
- `serve` 提供带随机令牌认证的反向 HTTP 连接，由宿主监听 loopback 并设置响应安全头。沙箱模式使用 `proxy-connect-v1` 受限代理（Unix socket 限制保持开启）；可信模式使用 `tcp-v1` 直接连接同一宿主桥。宿主不规定第三方应用的启动参数或内部服务 API。
- 两种模式进程 cwd 均是插件包目录，项目相对路径按 context.cwd 解释。Node/CLI 路径只是信息；可信模式也不主动传递调用核心的凭据。

所有参数以 argv 数组传递，不拼 shell 命令。核心 `--json` 和 `--plugin-port` 必须位于插件命令之前；命令之后的 token 属于插件，仅消费紧随命令名的第一个 `--`。现有核心命令的标志兼容逻辑保持原有行为。

委托成功后，插件拥有 stdout，包括它的一条 JSON 结果；宿主不追加成功兜底。诊断写 stderr，退出码透传。独立 `--help`/`-h` 使用登记的运行模式，但不生成上下文或要求链在线。插件业务 ready 的具体字段属于插件协议，核心不解析第三方的人类日志。

## 安全与平台范围

子进程不能代替安全沙箱。提供两种明确区分的运行模式：

- `sandbox` 为默认值。执行经过固定版本的 sandbox-runtime；缺少运行时、后端或不满足环境要求时拒绝执行，不自动降级。
- `trusted` 由用户通过 `plugin link <directory> --trust` 显式选择，可在 Windows/macOS/Linux 原生运行，不依赖 WSL、沙箱运行时或管理员初始化。以当前用户权限执行，**不提供操作系统文件或网络隔离**。包本身不能通过 manifest 选择此模式。

信任记录绑定规范目录、包名和版本；包名/版本变化或新增能力后需重新登记授权。现有登记仍为沙箱模式，重新 link 不带 `--trust` 会恢复沙箱。列表及 JSON 输出展示模式，上下文 `sandbox.backend` 为 `os` 或 `none`。本地包及其依赖仍可变；版本绑定不等于签名、内容校验或供应链保护。

沙箱模式默认只读运行所需的系统/包文件和上下文，只能经专属 data/cache/临时目录回写宿主。两种模式都清除调用者的凭据、代理、SSH agent、Node preload 和模块查找环境。能力请求必须在 link 时逐项授权；声明增加权限后旧登记失效，需重新授权。持久目录不得通过符号链接变成下次调用的新授权。

只读 RPC 网关只接受白名单方法、受限大小的 JSON-RPC POST 和最多 200 条的全只读批次；每个网关最多 16 个连接、8 个并发请求，自连接接受起整体限时 5 秒；成功响应显式携带 Content-Length，并在关闭前保留 100ms 排空窗口，不提供持久 keep-alive。关闭或断连会取消上游请求及未读响应；混入写方法整批拒绝。沙箱模式网络默认关闭，网页服务通过宿主桥接，不赋予任意 Internet、loopback 或 bind 权限。可信模式的能力只限制宿主主动提供的接口，不能阻止插件另行读取密钥、修改文件、连接节点或联网；启动提权的 offckb 也会使可信子进程获得同等权限。

OS 沙箱当前只支持 macOS/Linux，分别使用 sandbox-exec 和 bubblewrap，要求 Node 22.21+（22.x）或 24.5+。可信模式沿用核心 Node 20+ 要求，并检查插件自身 engines。Windows 原生提供可信执行；不接入有机器级安装影响及公开网络旁路的 sandbox-runtime Windows alpha 后端，不把 WSL 作为使用前提，也不承诺已验证 WSL 沙箱。[固定版本后端说明](https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#known-limitations)。任何第三方插件的存在都不是启用或禁用平台的依据。

沙箱不是 VM，也不提供 CPU/内存配额或可信 UI。授权目录、包内容、终端输出、OS/运行时漏洞仍需审查。固定运行时的 Zod 3 资源耗尽告警及当前仅解析宿主策略的受限路径见[指南](plugins.md#validation-and-limits)；不能因此把依赖视为已修复。

## 生命周期与验证

当前调用拥有前台子进程。POSIX 通过进程组转发 SIGINT/SIGTERM/SIGHUP 并限时等待；Windows 使用 taskkill /T /F 强制清理仍存活的子进程树，不伪装成优雅信号或 Job Object 容器。仅对本次拥有的进程操作，不向已退出或持久 PID 发信号。两种模式都清理网关、上下文和最小互斥记录；插件不得自行脱离前台生命周期创建 daemon，故意脱离或宿主被强杀可能留下进程。

注册写入使用 wx 锁和原子替换。运行租约拒绝同一插件并发启动和运行中 relink/unlink。崩溃、SIGKILL 或掉电仍可能留下锁和临时文件；自动恢复、持久进程身份与跨进程停止留待服务托管阶段。

宿主验收使用合成插件，不下载实际第三方应用：

- 静态声明、越界入口、撞名、损坏登记、授权变化和重复 CLI 调用。
- 生产 ncc 包中的 argv/JSON 边界、离线 help、上下文和前台退出清理。
- 原生 OS 沙箱下的文件读取、宿主写保护、符号链接、子进程、凭据和直接网络拒绝。
- 授权后的正向 data/cache、只读 RPC 与 HTTP 服务；失败后无权限扩张或残留运行状态。
- 原生 Windows/macOS/Linux Node 20 下的显式可信执行：不加载沙箱依赖，保留环境过滤/网关/参数/退出协议，正确标注无 OS 隔离，版本变更需重新信任。
- 本地 npm registry 与 Git 合成仓库的真实安装、脚本默认禁用/显式构建、固定来源、失败回滚、运行租约、更新和移除；公网 GitHub 认证/可用性不以离线测试代替。

实际插件各自负责业务就绪、上游兼容和真实链端到端测试；宿主通过该插件的业务测试不等于接受它为核心组成部分。后续自动更新、服务托管及第二案例抽象需要单独确定范围。
