# 二进制工具插件化方案

状态：**P1 已实现**（本分支）。JS 插件协议见 [plugin-system-proposal.md](plugin-system-proposal.md) 与 [plugins.md](plugins.md)；本文档为二进制 kind 的设计与实现记录。P2（npm 平台包来源、JS entry 可选透传）与 P3（其余工具 catalog 化、多版本并存）未实现。

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

1. 把 `ckb-debugger-install.ts` 的单体实现泛化为 plugin host 的 native 流水线（`src/plugins/native.ts`），ckb-debugger 成为 catalog 第一个条目；旧 `offckb install ckb-debugger` 转为 catalog alias；既有 `<data>/tools/ckb-debugger` 安装在首次安装时**搬入** native 目录（离线收编，版本以二进制实测为准），shim 同步刷新。
2. `offckb debugger` 旧命令保留，经 registry 解析二进制路径后 spawn（并修复了透传参数带入命令名本身的既有 bug）。
3. ckb-tui、ckb-tx-dumper、CKB/fnn node binary 逐个 catalog 化，`bins/` 与 `tools/` 两个散落目录最终收进同一 plugin home（P3）。

## 8. CLI surface

```sh
offckb plugin install ckb-debugger@v1.1.2     # catalog 名（精确 tag，重复安装零网络）
offckb plugin install ckb-debugger@latest    # 升级 = 再装一次：探远端 tag，不同则原子替换
offckb plugin install ckb-debugger           # create 流程用：本地满足 minVersion 时离线短路
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
- 版本语义：显式 tag 重复安装完全离线；`@latest` 总是探远端 redirect（代价一次请求），tag 不同才下载——这同时就是升级路径。
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
