# Fiber devnet 验证记录

对应设计：[Fiber devnet 初始化、配置与数据生命周期](fiber-devnet.md)。本记录描述开发者检查结果，不代表人工验收。

## 环境

- 2026-10-27，macOS arm64，Node.js 24.8.0。
- 实际 CKB 0.208.0、FNN 0.9.0（e6cb7ac）。FNN 发布包 SHA-256 与仓库已有固定值一致。
- 测试数据和下载文件放在本任务工作树的忽略目录中。独立配置指向测试链目录，没有重置用户原有本地链。

## 自动化检查

- `pnpm install --frozen-lockfile`：通过；仅新增官方 Biscuit WASM 依赖，保留原有其他依赖锁定记录。
- `pnpm typecheck`、`pnpm build`：通过。
- `pnpm lint`：通过，保留 `src/node/install.ts` 的一个既有 `any` 警告。
- Rebase 到 `develop`（`b444332`）后重新运行 `pnpm test:ci --runInBand --silent`：57 个测试套件通过，547 项通过，7 项按平台/原有条件跳过；覆盖率阈值通过。类型检查、lint、构建和锁定依赖安装也重新通过。
- `git diff --check`：通过。
- 发行构建额外验证：运行 `build/index.js` 的隔离入口执行已存在环境的 `fiber init`，加载随包发布的 Biscuit WASM/ESM 文件成功；无需启用 Node 的实验性 WASM 模块参数。

自动化重点包括：首次默认准备、显式准备、追加与编号上限、账户导入和随机账户、配置不覆盖、准备中断后复用密钥、FNN 加密密钥比对、启动前检查所有节点、Biscuit 签名和权限、凭证文件替换、HTTP 认证失败、运行信息快照、默认配置损坏及数据重置边界。Rebase 时新增检查：CKB 管理进程将信号交给 Fiber 后，初始化等待 FNN 程序下载期间收到 SIGTERM 也会退出，不吞掉信号。

## 实际 CKB/FNN 流程

- CKB 已运行时显式 `fiber init --nodes 3 --binary-path …`：准备三个节点，未创建 FNN 进程或数据库。
- 修改节点 3 的名称并启用 Biscuit 认证：三个节点统一启动成功，节点 3 的状态查询携带 token，`CUSTOM_CONFIG` 为 `yes`。
- 原节点运行时追加随机账户节点 4：只准备新节点；停止并启动 Fiber 后四个节点全部就绪，节点 4 以零余额启动并显示等待注资。
- 用本地链预分配账户向节点 4 转入 1000 CKB，确认及索引更新后可查到余额；没有重新初始化或重启 FNN，网络身份保持不变。
- 运行期间修改节点 3 的登记账户、配置文件内 RPC 地址及 token 路径：状态继续使用启动时的信息；恢复原文件后无需修复环境。
- 将运行中节点 3 的 token 文件临时替换为无效值：状态为 `unknown` 并明确指出认证失败，没有显示为 `stopped`；恢复文件后恢复正常。
- 在自动互连使用的第一个节点上启用认证：启动完成并互连成功，实际覆盖带 token 的 `node_info`、`connect_peer` 和 `list_peers`。
- 停止并再次启动四节点环境：逐文件 SHA-256 核对配置、FNN 加密后的 CKB 密钥、密码、Fiber 身份、Biscuit 密钥及 token，均未改变。
- 全新环境直接 `node --fiber --daemon --fnn-binary-path …`：无需先执行 `fiber init`，自动准备并启动默认两个节点。`node stop` 停止整套环境。
- Rebase 后使用真实 CKB/FNN 重跑已有双节点环境的 `node --fiber --daemon`、`fiber status` 和 `node stop`，认证节点与默认节点均正常，停止后无测试 CKB、矿工或 FNN 进程残留。新基线已包含含空格 CLI 路径的进程识别修复（#533）；本次移除初次验证使用的进程标题引号包装，在含空格的任务路径下直接通过后台停止检查。

## 未验证项与既有问题

- 普通 FNN 的节点管理、自定义配置保留与 RPC 认证已验证。LSP 及其他扩展工具的端到端行为未验证，也不属于本次基础节点管理的交付前提；OffCKB 没有 LSP 或 `lsp-cli` 运行依赖，不能仅凭配置保留宣称特定扩展兼容。
- 没有在 Windows/Linux 或 Node 20 上运行真实程序；自动化测试为本机结果，其他平台交由 PR CI。
