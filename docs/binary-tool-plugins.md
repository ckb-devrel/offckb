> **SUPERSEDED (2025-11)**: 本文件是二进制插件的**历史设计记录**。其中的来源白名单、
> `tool:`/HTTPS/本地 descriptor 安装、release 模板 catalog、linked-binary sandbox 等设计
> 已全部移除。现行设计见 [plugins.md](plugins.md)（入口矩阵）与
> [binary-tools.md](binary-tools.md)（catalog + 本地目录 + 维护者 descriptor 格式）。
> 保留原文以供追溯讨论脉络。
>
# 二进制工具插件化方案

状态：**已与 develop 的 `tool:` 描述符体系合并（#553 + #559）**。JS 插件协议见 [plugin-system-proposal.md](plugin-system-proposal.md) 与 [plugins.md](plugins.md)；本文档为二进制 kind 的设计与实现记录。

## 0. 与 #553 的合并架构（本 PR 的实际形态）

两套实现合并后的统一模型：

- **载荷格式**：采用 #553 的 `offckb-tool.json` 描述符（`platforms` 每平台 pin 死 `url + sha256 + format + executable`，`execution` 支持 `${devnet.rpcUrl}`/`${plugin.dataPath}`/`${plugin.cachePath}`/`cwd` 绑定，`permissions` 声明宿主能力）。仓库根探测、`tool:`/本地/HTTPS descriptor 安装、bundled 工具全部使用此格式；旧 `offckb-plugin.json` 仍可读（兼容本 PR 合并前的安装）。
- **注册与执行**：采用本 PR 的加固 native 注册（稳定路径 `<pluginHome>/native/<command>/`、锁内原子交换 + 回滚、source.id 语义、symlink fail-closed），所有来源（catalog / bundled / descriptor / github）统一到此模型。`offckb <tool>` 执行时二进制**一律原生运行**（不设沙箱默认值）——理由：现阶段所有真实二进制都是无适配的纯工具，主要价值在安装与管理；且二进制的主消费通道是直访（shim/spawn），任何宿主沙箱都盖不到，给代跑通道单独设沙箱只会造成"直跑可以、offckb 跑却 permission denied"的行为不一致（Windows 上更甚）。声明的 `permissions` 保留但语义为 advisory：只控制宿主提供的接口（如 `${devnet.rpcUrl}` 注入），不构成访问上限——与 trusted JS 插件一致。PATH shim / `plugin which` / `plugin env` 提供 Issue #555 要求的机器直访通道。
- **来源与信任**：catalog（一方 release 模板）与 bundled（随包 descriptor）隐式信任；显式本地/HTTPS descriptor 自证内容（pin 死 sha256，**总是重装**以重验内容，不做幂等跳过）；三方 GitHub 源（仓库根 `offckb-tool.json`）必须过**来源白名单**。声明了 `permissions` 的二进制工具同样需要显式 `--allow` 授权。
- **迁移**：既有 ckb-debugger 离线收编、`offckb install ckb-debugger` 别名、旧 shim（内嵌 marker）由默认 plugin home 认领——全部保留。

以下各节保留原始设计推理；与上文冲突处以上文为准。

## 1. 问题与硬约束

issue [#555 评论](https://github.com/ckb-devrel/offckb/issues/555#issuecomment-6978178698)（luongthanhtung03）给出的约束，是任何方案必须先满足的：

1. **第三方工具直接 spawn 二进制**：`ckb-testtool`、`ckb-cycle-tools` 每次测试运行会 spawn `ckb-debugger` 几十次。走 `offckb <command>` 每次委托不可行（多一层进程 + 宿主不在它们的调用路径上）。
2. **稳定路径或 env var**：升级后路径不能变，或者提供一个指向它的环境变量。
3. **pinned version 易升级**：`--vm-id` profiling 需要 ≥ 1.1.2，固定版本要一键可升。
4. **Windows 必须有真 `.exe` 在 PATH**：`.cmd` shim 对无 shell 的 `spawnSync` 不可见（PR #559 已合入：hardlink/copy + `.offckb` marker，需泛化而不是复制粘贴）。

用户诉求：offckb 统一管理许多零散二进制插件，统一接入。

## 2. 核心判断：同一 registry，第二种 kind

现有插件协议是 **JS 插件宿主**：npm 包形态 + 静态声明 + `.js/.cjs/.mjs` entry + 子进程 + context JSON + 能力授权 + 沙箱。二进制工具几乎违反每条假设：

| 维度 | JS 插件 | 二进制工具 |
| --- | --- | --- |
| 执行 | 宿主 spawn Node 子进程，拥有 stdout/lease/生命周期 | 宿主通常**不在场**；第三方工具直接 spawn |
| 入口 | 包内 JS 文件 | 平台相关原生可执行文件 |
| 安全边界 | sandbox（OS 隔离）/ trusted + 能力授权 | 安装即信任；放到 PATH 上的原生代码 = 用户 OS 权限 |
| 消费方式 | `offckb <command>` 委托 | 稳定路径 / PATH / env var |

所以正确的统一是**统一生命周期与发现，而不是统一执行协议**：在同一个 plugin registry 里加 `kind: 'binary'`，共享 install/remove/list/版本固定/来源校验/原子替换/shim 策略，执行侧走"暴露"而不是"委托"。

## 3. 注册表与声明扩展

`Registration` 增加显式判别字段 `kind: 'js' | 'binary'`（缺省 `js`）；registry 保持 apiVersion 2，binary 注册项是新增的可选字段，与 JS 的 `installation` 互斥，校验强制 `kind` 与字段形状一致。binary 注册项跳过 entry/engines/permissions/context 校验，仍保留运行租约（lease），改为记录：

```json
{
  "kind": "binary",
  "binary": { "binName": "ckb-debugger", "version": "1.1.2", "path": "<pluginHome>/native/ckb-debugger/ckb-debugger" },
  "shim": { "path": "<npm-global>/ckb-debugger", "markerOwned": true }
}
```

包声明（`package.json` 的 `offckb` 字段，或纯二进制 descriptor，见 §4）：

```json
{
  "offckb": {
    "apiVersion": 1,
    "kind": "binary",
    "command": "ckb-debugger",
    "binary": { "name": "ckb-debugger" }
  }
}
```

## 4. 来源模型：两种都支持

- **B · GitHub release descriptor（已实现）**。三方仓库根目录声明 `offckb-plugin.json`（`apiVersion: 1, kind: "binary"`，`release` 必含 `repo`、`asset` 模板（`{tag}`/`{target}`）、`checksum` 模板——**必填，fail-closed**）。安装器探测该文件决定走二进制还是 JS npm 流程；descriptor 存在但字段非法直接报错，不静默回退。catalog 即内置的同构 descriptor 集合。
- **A · npm 平台包（未实现，P2）**。`optionalDependencies` 按平台分包（esbuild 模型），完全复用现有 installer。包可另带 JS entry 作为人类友好的 `offckb <command>` 透传。

## 5. 统一接入：三条通道

1. **稳定路径**：`<pluginHome>/native/<command>/<binName>`（`<pluginHome>` 默认 `<data>/plugins`，`OFFCKB_PLUGIN_HOME` 可隔离）。升级时在**同一路径**原子替换文件，路径终生不变。POSIX 上运行中的旧 inode 不受影响；Windows 上被占用则 EBUSY，在 registry 提交**之前**失败，旧版本保持可用，明确报错稍后重试。
2. **PATH shim**：写在 offckb binary 旁边（该目录已在 PATH 上，零配置）；所有权由 `.offckb` sidecar marker 绑定**文件内容哈希**（command + sha256），stale marker 旁被用户替换的文件不会被覆盖或删除，symlink 永不认领；脚本另保留内嵌 marker 行作兼容识别。Windows 同时放真 `.exe`（hardlink，跨盘 fallback copy）。remove 时按 isOwned 重验哈希再清理，外来文件只警告。
3. **事务性**：staged 目录在 registry 锁内交换（EBUSY 在提交前失败，旧版本完整可用）；registry 写失败时回滚目录交换，注册与磁盘始终一致；legacy 收编先拷贝后删除，任何失败不丢用户原有二进制。
3. **env var + 查询**：
   ```sh
   offckb plugin which ckb-debugger [--json]   # 打印稳定路径
   offckb plugin env [--json]                  # 打印 OFFCKB_TOOL_CKB_DEBUGGER=<path> 等，供 eval "$(offckb plugin env)"
   ```
   offckb 自己 spawn 子进程（如未来的 test/deploy 流程）时注入这些变量。

## 6. 信任模型与来源白名单

二进制插件**只支持 trusted**：它没有沙箱默认值，安装会**把可执行文件放上 PATH**——影响面是所有 shell 和所有按名字 spawn 它的工具，远大于跑一次 JS 插件。所以审批粒度不能只到"这次安装"，要提升到**来源**：

- **catalog 源（一方）**：随 offckb 发布的 descriptor，repo/版本/checksum 政策由团队维护，隐式在白名单内，安装无额外摩擦。这是宿主唯一内置的"白名单条目"，且只含一方工具。
- **三方源**：一律要求显式审批，记录在用户本地的 allowlist（`<pluginHome>/trusted-sources.json`，沿用 registry 的 wx lock + 原子替换，0o600）。

白名单规则：

- 绑定**源身份**（`source.id`：catalog 记 name、GitHub 记小写 `owner/repo`）而不绑定版本。版本仍由每次 install pin。**同源升级（`@latest`）不重复审批**——保住"易升级"诉求。
- GitHub 源的 descriptor 声明的 `release.repo` 必须与安装源仓库一致，否则拒绝——白名单批准的是"你安装的这个仓库"，descriptor 不能把二进制指去别处扩大批准范围。
- 同一 command 换源 = 新源须先审批 + 显式 reinstall。GitHub repo 改名/转移后源身份变化，自动要求重新审批——这是白送的安全属性。
- 审批命令把后果打印清楚（"该源的二进制将以你的权限运行并放置到 PATH"），CI 场景可用 `--trust-source <source>` 把"add + install"合成一步。
- 注册入口收敛：binary 只能由 native installer 注册（`plugin link` 与 npm 安装路径显式拒绝 binary descriptor），从入口上杜绝绕过白名单。
- 明确**不做**的事：不做随 offckb 发布的全局三方认证列表（违反"宿主不内置第三方包列表"边界，且把上游可用性变成发布门槛）；不做远程发布者认证/attestation（沿用"包名是本地命名空间"的既有立场）。防篡改仅限文件权限——能写你 plugin home 的攻击者已能造成更大破坏。
- JS 插件不适用来源白名单：它们有 sandbox 默认值，trust 已按 name/version 绑定，安全模型不同。

## 7. first-party catalog 与迁移

宿主内置一小份**官方 descriptor 目录**（仅声明数据：repo、asset 命名、checksum 位置、minVersion，无内置代码路径），让 `offckb plugin install ckb-debugger@v1.1.2` 开箱即用；目录即 §6 来源白名单内的一方源，第三方插件仍自生自灭，目录不背书第三方。`settings.tools.ckbDebugger.minVersion` 这类最低版本政策对 catalog 工具保留，descriptor 内可覆盖。

迁移路径（ckb-debugger 已按此落地）：

1. 把 `ckb-debugger-install.ts` 的单体实现泛化为 plugin host 的 native 流水线（`src/plugins/native.ts`），ckb-debugger 成为 catalog 第一个条目；旧 `offckb install ckb-debugger` 转为 `plugin install` 的完整别名（参数面完全对齐，catalog 名/npm 包/github 仓库/本地目录及 `--trust`/`--allow`/`--read`/`--allow-scripts` 全部等价）；既有 `<data>/tools/ckb-debugger` 安装在首次安装时**搬入** native 目录（离线收编，版本以二进制实测为准），shim 同步刷新。
2. `offckb debugger` 旧命令保留，经 registry 解析二进制路径后 spawn（并修复了透传参数带入命令名本身的既有 bug）。
3. ckb-tui、ckb-tx-dumper、CKB/fnn node binary 逐个 catalog 化，`bins/` 与 `tools/` 两个散落目录最终收进同一 plugin home（P3）。

## 8. CLI surface

```sh
offckb plugin install ckb-debugger@v1.1.2     # catalog 名（精确 tag，重复安装零网络）
offckb plugin install ckb-debugger@latest    # = 当前 catalog 固定版本（同版本重复安装零网络）；升级随 offckb 更新到达
offckb plugin install ckb-debugger           # = offckb install ckb-debugger（完整别名，参数面一致）
                                             # 首次安装且旧版满足 descriptor minVersion 时离线收编（仅裸名/@latest 触发，版本以实测为准）
# offckb create 的宽松短路在 create 链路里：已装版本满足 minVersion 即离线通过，不强制升级
offckb plugin install github:owner/repo#v1 --trust-source owner/repo   # 三方源：审批+安装一步
offckb plugin trust add owner/repo           # 单独审批一个三方源
offckb plugin trust list                     # 查看已审批源
offckb plugin trust remove owner/repo        # 撤销；既有安装冻结在原版本，升级/重装需重新审批
offckb plugin list                           # 两种 kind 同列，标注 mode/source/kind
offckb plugin which ckb-debugger             # 稳定路径（--json 机器可读）
offckb plugin env                            # OFFCKB_TOOL_*=path，可 eval "$(offckb plugin env)"
offckb plugin remove ckb-debugger            # 删包 + 按 marker 清 shim
offckb ckb-debugger -- --version             # 人类透传：直接 spawn 托管二进制
```

实现要点：

- registry 仍为 apiVersion 2：binary 注册项是新增的可选字段（`binary: {binName, version, path, source}`），与 JS 的 `installation` 互斥；JS 注册项语义零变化。
- 版本语义（实现）：catalog 版本随 offckb 发布钉死（version-bump PR）。`@latest` 与裸名都解析为当前钉死版本：本地 registry 已是该版本时重复安装完全离线（零请求）；未安装时按 descriptor 下载钉死版本。非钉死的显式 tag fail-closed，报错并提示钉死版本。legacy 收编只发生在首次裸名/`@latest` 安装、且旧二进制满足 descriptor `minVersion` 时：离线搬入旧安装、版本以二进制实测为准、全程零下载；下一次 `@latest` 在钉死版本更高时升级。显式 tag/pin 不触发收编。
- legacy 收编：catalog descriptor 可带 `legacyInstallDir`，首次安装把 `<tools.rootFolder>/<name>` 下的旧二进制**搬入** native 目录（一次性迁移，版本号以二进制实测为准，全离线），旧目录随后删除；消费方走 PATH shim / 稳定路径，不感知绝对路径变化。

`plugin list`/JSON 对 binary kind 显示 `trusted` 与 resolved 版本；`shadowed`、损坏登记不阻断核心命令等现有语义原样沿用。

## 9. 分阶段落地

1. **P1（已实现）**：binary kind（registry 可选字段）+ native 流水线（descriptor/catalog 来源）+ shim 泛化 + `which`/`env` + 来源白名单 + ckb-debugger 迁移（`offckb install ckb-debugger` 别名、`offckb debugger` 透传参数修复、旧安装离线收编）。ckb-testtool/ckb-cycle-tools 的三条硬约束在此阶段全部闭环，并附 E2E 验收（真实下载 v1.1.2 + checksum 校验 + 直接 spawn + eval env + 升级/移除）。
2. **P2（未实现）**：A 来源（npm 平台包）+ JS entry 可选透传。
3. **P3（未实现）**：ckb-tui、ckb-tx-dumper、CKB/fnn node binary catalog 化；评估 sandbox 包裹与多版本并存（`plugin use <command>@<version>`）。

## 10. 已决策与遗留问题

已决策（按讨论定案，均已在 P1 落地）：

1. binary kind 信任边界：只 trusted，校验只在安装期（§6）。
2. 既有二进制收编：旧 `<tools.rootFolder>` 下的安装由首次安装**搬入** native 目录（一次性），消费方经 PATH shim / 稳定路径访问，不感知内部绝对路径变化。
3. Windows 升级遇 EBUSY：registry 提交前失败，旧版本保持可用，明确报错重试（不做延迟 swap）。
4. minVersion 政策：descriptor 可覆盖，宿主 settings 保留兜底默认值（低于 min 的显式 pin 告警但照装）。
5. 三方二进制源必须经本地来源白名单审批（§6）；catalog 一方源隐式信任。

遗留（实现期细化即可）：

- npm 源白名单粒度默认 scope 还是精确包名（倾向精确包名，scope 作为可选简写）。
- `plugin trust remove` 后既有安装是"冻结在原版本"还是"直接停用"（倾向前者，与 npm 已装包语义一致）。
