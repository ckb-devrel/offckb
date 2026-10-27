# Fiber devnet：初始化、配置与数据生命周期

目标是让默认节点和改过配置的节点都能由 OffCKB 统一管理：首次直接启动就能用，需要提前配置时才单独初始化，日常重启保留配置和数据。

本次功能面向尚未正式发布的 Fiber devnet，不兼容旧 `nodes[].config` 格式，不自动导入旧目录或迁移旧环境。只管理一套普通 OffCKB 本地链；不支持 fork、主网、测试网或并行的多套环境。

OffCKB 管理的是 FNN 节点进程、配置、账户和管理 RPC，不依赖 LSP 或 `lsp-cli`，也不调用这些工具。LSP 只是完整配置可保留的一种使用场景；是否启用、支持哪些配置，由用户选择的 FNN 决定。普通节点无需安装或配置 LSP。

## 使用方式

与 CKB 的 `offckb node` 一样，简单启动不要求先执行初始化命令：

```sh
offckb node --fiber --daemon # 首次自动初始化两个 Fiber 节点，再启动
# 或先运行 CKB，再单独启动 Fiber
offckb node --daemon
offckb fiber start --daemon
```

`offckb fiber init [FNN-Version]` 是可选的“只准备、不启动”步骤。CKB 本地链准备好后，可以先准备配置和密钥，手动或用外部工具修改 FNN 配置，最后执行 `fiber start`。

```sh
offckb fiber init --nodes 3 --binary-path /absolute/path/to/fnn
# 按所选 FNN 支持的功能编辑输出的节点 3 config.yml
offckb fiber start --daemon
offckb fiber init --add --account-index 12
# 或：offckb fiber init --add --random-account
```

- `init` 的 `--nodes N` 与 `--add` 互斥。首次默认创建节点 1、2；已有环境不传参数时只检查、复用。`--nodes N` 补齐 1 至 N，不删除其他节点，列表中有范围外节点时拒绝。
- `--add` 只用于已有环境；编号为已登记节点和保留目录的最大编号加一，不复用旧目录。编号限制为 1 至 16。
- `--account-index` 与 `--random-account` 互斥，只用于 `--add`。批量初始化可预先在新格式的 `nodes.yml` 中指定各节点账户；尚未初始化的记录需显式标记 `initialized: false`。
- `fiber start` 保留 `--daemon`，首次也接受版本、`--binary-path`、`--nodes`，复用同一个初始化流程。已有环境中的这些参数必须与已保存记录一致，否则报错，不修改环境；增添节点使用 `init`。
- `node --fiber` 同样保留首次初始化用的 `--fiber-nodes`、`--fnn-version`、`--fnn-binary-path`。这不是旧配置兼容，而是与 CKB 保持一致的启动入口。
- 初始化后固定 FNN 程序及模板的绝对路径；启动不自动下载、升级或替换程序。路径失效时明确报错。自编译程序允许没有版本号；模板优先使用程序旁的 `config/testnet/config.yml`，没有时明确提示使用 OffCKB 配套模板。
- 追加节点可以在原节点运行时进行；新节点不会自动启动。追加后停止并重新启动 Fiber，才会运行全部节点。

## 配置和账户

`devnet/fiber/nodes.yml` 记录程序、节点和账户，文件权限为当前用户读写（支持 POSIX 权限的平台为 `0600`）：

```yaml
fnn:
  binary_path: /absolute/path/to/fnn
  template_file: /absolute/path/to/config/testnet/config.yml
  version: 0.9.0
nodes:
  - id: 1
    initialized: true
    account:
      type: builtin
      index: 3
    config_file: nodes/1/config.yml
    rpc_token_file: nodes/1/rpc-token
```

配置和 token 的相对路径均相对 `nodes.yml` 所在目录解析。每个节点只使用 `config_file` 指向的完整 FNN 配置；初始化只生成一次，重复初始化和启动不得改写。初始化的默认配置另外保存在节点的 `config.default.yml` 中，用于 `CUSTOM_CONFIG` 判定。

允许添加所选 FNN 支持的服务、RPC 模块及 Biscuit 认证等配置，例如启用 LSP。OffCKB 只检查其管理所需条件：保留 `fiber`、`rpc`、`ckb` 服务及 `info`、`peer` RPC 模块；使用本环境的链、合约、CKB RPC、固定节点端口和节点内的数据目录。其他 FNN 字段由 FNN 校验，不复制整套 FNN 配置规则。所有节点通过预检查后才创建进程。

默认账户只在首次准备时按“节点编号 + 2”计算并写入。内置账户显式保存 `type: builtin`、`index`；自选或生成私钥使用 `type: random`、`key: "0x…"`。新的随机账户可省略 `key`，由初始化生成并保存；重复初始化、列表重排及重启不重新生成。随机账户不加入创世预分配、不自动注资。零余额允许启动，并输出等待注资的提示。

资金账户、Fiber 网络身份、Biscuit 密钥分别管理。启动前检查账户与 `ckb/key`（含 FNN 加密后的格式）一致；启动后和状态查询核对 `node_info.default_funding_lock_script`。多个节点共用同一资金锁时仅警告，说明可能发生 Cell 竞争或被 FNN 拒绝共同出资。

初始化采用持久的准备记录保存新账户，再创建文件，最后提交节点登记。中断后重试复用已保存的密钥；已完成节点缺少必需文件时拒绝重新生成。无登记也无准备记录的旧目录不会被导入或覆盖。

## RPC 认证与状态

每个新节点独立生成 Biscuit 密钥对和覆盖 `node_info`、`list_peers`、`connect_peer` 所需 node/peer 权限的管理 token（不授予通道、支付操作权限）。密钥保存为节点目录下 `biscuit/private.key`、`biscuit/public.key`，token 保存为 `rpc-token`。默认不启用 RPC 认证；用户启用时把对应公钥配置到 `rpc.biscuit_public_key`。无论手动还是用外部工具配置认证，管理 token 都需要与生效的 RPC 公钥匹配，并具有上述权限。更换公钥后需同时提供匹配的管理 token；OffCKB 不自动覆盖用户或外部工具的密钥、配置。

内部 RPC 在认证开启时自动读取对应 token，并发送 `Authorization: Bearer …`。认证失败、权限不足、文件丢失与节点停止分别报告，不输出 token 或私钥。

`fiber status` 增加 `CUSTOM_CONFIG`：比较解析后的 FNN 配置值，忽略注释、空白及字段顺序；与初始化基准相同时为 `no`，否则为 `yes`。基准缺失或损坏为 `unknown`，附原因，不妨碍使用有效的活动配置。

运行记录保存启动时使用的节点列表、公开账户信息、配置及 token 路径、RPC 地址和配置判定，不保存私钥或 token 正文。运行中修改登记或配置，需重启才生效；状态继续使用启动时记录。原 token 路径中的文件内容可以替换，管理调用会重新读取，方便凭证恢复。未运行节点按当前文件判断，注明配置尚未生效。

## 重启与重置

| 操作                       | 结果                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| 停止后重新启动 CKB / Fiber | 复用配置、密钥和数据；普通运行设置重启后生效                          |
| `fiber init` / 追加节点    | 准备并检查，不清理链、不删除已有节点数据                              |
| `fiber clean --data`       | 删除 Fiber 通道、支付等运行数据；保留账户、身份、密码、认证材料和配置 |
| `fiber clean`              | 删除整个 Fiber 环境；保留 CKB 本地链                                  |
| `clean --data`             | 重置 CKB 链及依赖它的 Fiber 运行数据；保留配置和密钥                  |
| `clean`                    | 删除整套 devnet，含 Fiber 配置、密钥和数据                            |

后台节点用 `node stop` / `fiber stop` 停止；前台用 Ctrl+C。`node --fiber --daemon` 由同一个管理进程启动，停止该管理进程会停止整套环境。清理前沿用进程身份和数据库锁检查。

CKB 配置编辑器不再把 `clean -d` 当作普通重启步骤。普通运行配置修改后停止并重新启动；修改创世链规格才需要明确的重置，并告知会丢失链和 Fiber 数据。Fiber 数据重置清理 OffCKB 管理的 `fiber/store`；扩展功能自行配置的其他存储不在该操作的清理范围内，不把密钥目录当作数据库删除。

## 验证与交付

自动化覆盖默认自动初始化、显式初始化、追加与编号边界、配置保留、准备中断重试、密钥一致性、零余额、RPC 认证错误、运行状态记录以及重启与重置边界。检查文档和 CLI 帮助一致，并运行类型检查、lint、构建和测试。

实际 CKB/FNN 验证：默认启动、三个节点、自定义配置保留、认证、停止重启及外部注资。基础节点管理以普通 FNN 验证，不以 LSP 或其他扩展工具的联调作为交付前提。特定扩展的端到端行为属于可选的集成验证，不能仅凭配置保留就宣称兼容。交付和 PR 如实记录已验证与未验证项。
