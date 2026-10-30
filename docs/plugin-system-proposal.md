# offckb 工具插件协议与宿主边界

状态：**实现草案，供代码审阅；不构成人类验收或接受的 Context。** 实际操作、字段和平台限制见[插件指南](plugins.md)。

## 目标与归属

让第三方工具在不修改 offckb 核心源码的情况下，获得当前开发环境、注册独立命令并受控运行。核心负责发现、兼容检查、授权、环境快照和前台生命周期；插件作者负责自己的功能、依赖、界面、就绪判断和发布。

所有实际应用插件地位相同，均应独立维护和发布。宿主不内置首选插件，不固定某个应用的包名、版本、参数或链支持策略，也不把它的上游发布作为宿主交付门槛。本 PR 只保留协议探针和合成测试；实际适配包及其业务端到端测试放在独立插件仓库。

采用 **npm 包形态 + 静态声明 + 独立子进程 + OS 沙箱**。先验证本地接入与安全边界，不引入 Cordis DI、事件总线、热重载、profile、bundle 或插件间依赖，不迁移现有核心工具命令。

## 借鉴 dsh 的边界

调研基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。它通过 Cordis 服务依赖、bundle 分发及 profile 组合配置来组织整个产品，需求范围大于当前外部工具接入。

| 借鉴点 | 当前实现 |
| --- | --- |
| 声明与运行分离 | 发现阶段只读 package.json，不执行插件取得名称和摘要 |
| 安装、可发现、兼容与运行状态分离 | 包由用户准备；登记由 link 管理；list 报告声明、兼容及撞名问题；实际就绪由插件负责 |
| 副作用随卸载或退出回收 | 当前调用拥有子进程、网关和临时文件；不提供跨进程 stop 或后台服务 |
| 使用成熟包管理工具 | 插件可独立发布 npm；首阶段没有内置 registry 安装器 |
| 兼容前置检查 | 执行前检查协议、入口路径、Node engines 和显式授权 |
| 服务容器、profile、bundle、HMR | 等多个真实插件提出共同需求后再评估 |

依据：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/architecture.md)、[插件 CLI](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/apps/cli/src/plugin.ts)、[Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/boot/plugin-manager/README.md)。这些参考不意味着复刻其完整生命周期或配置模型。

## 包与安装

一个包对应一个简单命令命名空间；子命令由插件自行解析。

```json
{
  "name": "my-offckb-tool",
  "version": "0.1.0",
  "engines": { "node": "^22.21.0 || >=24.5.0" },
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

当前只提供 `plugin link/list/unlink`。用户在独立目录安装精确版本、禁用生命周期脚本并检查包后，显式登记目录；link 本身不安装或执行代码。未来是否需要内置安装器，取决于实际安装困难，不由协议已经可用推导。

若增加安装器，先保持固定 registry 版本、独立安装目录、staging 校验、原子登记和失败保留旧版本；完整性使用 npm lockfile，不另建重复校验系统。Git/tarball 安装源及任意构建脚本不在当前范围。Windows npm 入口及带空格路径仍须单独验证，不能把 npm.cmd 当作可直接用 shell:false 执行的原生程序。

核心命令优先。重复插件名明确失败；升级后核心新增同名命令时，插件标为 `shadowed`，保留移除能力。损坏登记或声明不应阻断核心命令，也不应被发现流程自动覆盖。

## 环境与参数协议

`OFFCKB_PLUGIN_CONTEXT` 指向本次临时 JSON，包含 API/offckb 版本、调用目录、输出格式、插件专属 data/cache 目录、链身份及系统脚本快照。不会复制完整 settings 或账户私钥。字段详情以[插件指南](plugins.md#context-and-output)为准。

- 无 `devnet-read` 授权时 RPC 字段为空；有授权时只暴露宿主只读网关，原始 URL 和认证留在宿主。
- 链元数据由托管 CKB 本地 `list-hashes` 提供，限时三秒；缺失或失败降级为 `unknown`，必要时附脱敏诊断。需要链身份的插件自行决定是否拒绝，并验证 RPC genesis。
- `project-deployment` 授予调用项目 deployment 的只读访问；额外路径用 `--read` 显式授权。路径字符串本身不授予访问权。
- `serve` 允许插件通过指定 Unix socket 主动提供 HTTP 连接，由宿主监听 loopback 并设置响应安全头。宿主不规定第三方应用的启动参数或内部服务 API。
- 沙箱进程 cwd 是插件包目录，项目相对路径按 context.cwd 解释。Node/CLI 路径只是信息，不代表能够绕过权限调用核心。

所有参数以 argv 数组传递，不拼 shell 命令。核心 `--json` 和 `--plugin-port` 必须位于插件命令之前；命令之后的 token 属于插件，仅消费紧随命令名的第一个 `--`。现有核心命令的标志兼容逻辑保持原有行为。

委托成功后，插件拥有 stdout，包括它的一条 JSON 结果；宿主不追加成功兜底。诊断写 stderr，退出码透传。独立 `--help`/`-h` 仍在沙箱执行，但不生成上下文或要求链在线。插件业务 ready 的具体字段属于插件协议，核心不解析第三方的人类日志。

## 安全与平台范围

子进程不能代替安全沙箱。执行插件必须经过固定版本的 sandbox-runtime；缺少运行时、后端或不满足环境要求时拒绝执行，没有不安全回退。

默认只读运行所需的系统/包文件和上下文，只能经专属 data/cache/临时目录回写宿主。清除调用者的凭据、代理、SSH agent、Node preload 和模块查找环境。能力请求必须在 link 时逐项授权；声明增加权限后旧登记失效，需重新授权。持久目录不得通过符号链接变成下次调用的新授权。

只读 RPC 网关只接受白名单方法、受限大小的 JSON-RPC POST 和最多 200 条的全只读批次；混入写方法整批拒绝。网络默认关闭，网页服务通过宿主桥接，不赋予任意 Internet、loopback 或 bind 权限。

当前运行器只支持 macOS/Linux，分别使用 sandbox-exec 和 bubblewrap。Windows 的静态包协议及核心命令不因此失效，但插件执行尚未实现。所选后端的 Windows 机制涉及专用账户、ACL 和机器级 WFP 安装，并公开列有令牌切换、系统服务代发网络等旁路；当前宿主也没有完成原生路径、HTTP 传输和进程树适配。因此不能仅删除平台检查就宣布同等隔离。[固定版本后端说明](https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#known-limitations)。

启用 Windows 前须确定满足权限边界的后端、明确安装影响，并通过原生文件、凭据、网络及后代进程清理测试。任何第三方插件的存在都不是启用或禁用平台的依据。

沙箱不是 VM，也不提供 CPU/内存配额或可信 UI。授权目录、包内容、终端输出、OS/运行时漏洞仍需审查。固定运行时的 Zod 3 资源耗尽告警及当前仅解析宿主策略的受限路径见[指南](plugins.md#validation-and-limits)；不能因此把依赖视为已修复。

## 生命周期与验证

当前调用拥有前台进程组，转发 SIGINT/SIGTERM/SIGHUP，限时等待并清理网关、上下文和最小互斥记录。仅对本次拥有的进程操作，不向持久 PID 发信号。插件不得自行脱离前台生命周期创建 daemon。

注册写入使用 wx 锁和原子替换。运行租约拒绝同一插件并发启动和运行中 relink/unlink。崩溃、SIGKILL 或掉电仍可能留下锁和临时文件；自动恢复、持久进程身份与跨进程停止留待服务托管阶段。

宿主验收使用合成插件，不下载实际第三方应用：

- 静态声明、越界入口、撞名、损坏登记、授权变化和重复 CLI 调用。
- 生产 ncc 包中的 argv/JSON 边界、离线 help、上下文和前台退出清理。
- 原生 OS 沙箱下的文件读取、宿主写保护、符号链接、子进程、凭据和直接网络拒绝。
- 授权后的正向 data/cache、只读 RPC 与 HTTP 服务；失败后无权限扩张或残留运行状态。

实际插件各自负责业务就绪、上游兼容和真实链端到端测试；宿主通过该插件的业务测试不等于接受它为核心组成部分。后续安装器、服务托管及第二案例抽象需要单独确定范围。
