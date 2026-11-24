# 企业受管策略：受管配置作用域与权限判定顺序

> 状态：已实现并经自动化测试验证（2026-11-24）；两条人工验证尚未执行，见末尾的验证记录。对应企业版改造点 T1（受管配置作用域）与 T3（权限判定顺序、`--mode` 取值受策略约束）。改造点编号见企业版方案文档 6.2 节。
> T2 在运行时这一侧的内容（切换入口的拒绝、向界面公布被禁的模式）见“入口处与界面公布”一节，与 T1、T3 同一份规格，因为它们共用同一个所有者；它的验证记录在同一节的末尾。界面那部分的规格在 [docs/ui/managed-mode-selector.md](../../../../docs/ui/managed-mode-selector.md)。策略的拉取、验签与写入（T6）不在此列。改造点索引见 [docs/ee/README.md](../../../../docs/ee/README.md)。

## 背景

企业版需要管理员下发两类约束：禁用某些工具；限制可用的权限模式（例如禁止 `yolo`）。现有实现在三处做不到。

- **模式放行排在规则之前。** `PermissionService.checkPermission` 里，`yolo` 与 `guarded` 的放行先于 `disallowedTools` 与项目 `deny`。这两个模式下，普通工具的禁用完全不生效。这是上游有意的语义，使用文档也如此描述（`docs/usage/05-permissions.md`）。
- **没有管理员来源。** `ConfigScope.System` 只是内置默认值。配置的全部载体（用户配置、CLI 参数、本地数据库、会话文件、环境变量）都归用户所有。
- **配置按整段替换，不按键合并。** 高层只要出现 `permission` 段，低层该段的其余键就回落到内置默认值。所以“再加一层”不能表达“只钉住所列的键”。

本规格建立机制：一个高于一切用户来源的受管来源，以及“受管约束先于模式放行”的判定顺序。

## 目标

1. 受管文件列出的工具被禁用后，在**任何模式**下调用都被拒绝，包括 `yolo`、`guarded`、Plan 开启时的 `guarded`。
2. 受管文件限制可用模式后，不被允许的模式**在判定上不产生放宽效果**，且启动时的默认模式与 CLI 的 `--mode` 都遵守它。
3. **没有受管文件时，行为与上游完全一致。**
4. 为 T6 预留：受管来源只有一个所有者，T6 把验签后的策略交给它，不另起一套合并逻辑。
5. **运行时不再进入被禁的模式，并把被禁的模式告诉界面**（T2）。会话显示的模式就是实际生效的模式。

## 非目标

- **策略的分发与可信性。** 本规格不给安全性保证：受管文件所在位置由操作系统权限保护，但没有签名校验，也没有“本机应当有策略”的登记。能获得管理员权限的人可以删除或改写它。验签与生效版本回报属于 T6，模型网关对未回报设备的拦截属于纵向链路 2。
- 通用的“逐键钉住任意配置键”。本规格的受管键都走专门的通道，不需要通用合并。第一个需要通用钉住的键出现时（C5 的只读受管 Provider）再实现，并遵守下面“产品规则”第 6 条。
- 设置界面里一般配置键的只读展示。受管策略目前没有任何设置键，等策略扩展后再做。
- 模式菜单以外的入口：自动化与闲时任务编辑器的模式下拉、权限弹窗里的“放行并切换”。它们照旧列出全部模式，运行时在切换处拒绝（见“入口处与界面公布”）。
- 终端界面的 `/mode` 列表与循环快捷键。运行时的拒绝对它已经生效；让它跳过被禁的模式、标出原因，单独一个提交。
- MCP、Hook、插件的受管范围（T11，二期）。

## 产品规则

1. **受管只收紧，不放开。** 受管文件能禁用工具、限制模式；不能让任何在低层被禁的东西变为可用。
2. **受管禁用不可逾越。** 它对所有模式、所有入口生效，结果是拒绝而不是询问，不能被项目 `allow`、会话授权、PreToolUse Hook 的 allow 或审批应答解除。
3. **受管禁用覆盖所有会执行工具的运行时。** 包括主会话、子代理，以及项目记忆代理——后者目前固定以 `yolo` 运行，并使用不带任何限制的默认权限配置。
4. **不在允许列表里的模式按回退模式判定。** 回退模式是 `build`（若它被允许）；否则是允许列表里最严格的那个。严格度沿用 `PERMISSION_MODE_STRICTNESS` 的次序。
5. **没有受管文件就没有任何影响。** 不读、不写、不报；合并结果、诊断、来源信息与上游相同。
6. **受管层只钉住所列的键，不整段替换。** 低层为其他键设置的值保持不变。
7. **受管文件无效时，应用拒绝启动。** 错误信息指明文件路径与原因。这是有意的：现有各来源“解析失败就跳过”的惯例，对策略文件等于失败即放开。

## 所有权与边界

| 职责 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 受管文件的定位、读取、校验 | `adapters/src/config` 的受管配置加载器 | 只读。不复用 `loadFileConfig`：它读取时可能因旧插件迁移而写盘 |
| 策略事实 | core 的 `PermissionConfig` | 在创建应用时由受管来源构造一次；会话运行期间不变，新策略对新建的会话生效 |
| 模式是否允许的判定 | contracts 的纯函数 | 判定处、启动处与写入点共用同一份规则，不各写一遍 |
| 权限判定 | `PermissionService.checkPermission` | 仍是唯一的判定点 |
| 执行状态（模式与 Plan）的修改 | core 的 `applyRuntimeExecutionState` | 唯一的写入点；显式切换在这里被拒绝，随请求携带的声明在这里换成回退模式 |
| “哪些模式被禁”的读取 | `PermissionService` 的只读访问器，应用层转发 | 应用创建时构造一次；界面、TUI 与写入点都读这一份，不各自读受管文件 |

受管作用域登记为 `ConfigScope.Managed`，优先级高于 `Cli`。它**不参与** `mergeConfigs` 的整段替换：受管的键由各自的通道消费（禁用工具进 `PermissionConfig`；可用模式经 contracts 的判定函数）。原因见“背景”第三条。

## 载体

一个 JSON 文件。默认位置按平台：

| 平台 | 路径 |
| --- | --- |
| macOS | `/Library/Application Support/ZCode/managed-config.json` |
| Linux | `/etc/zcode/managed-config.json` |
| Windows | `%ProgramData%\ZCode\managed-config.json` |

路径只能由程序的调用方经选项 `managedConfigPath` 指定，用途是测试、嵌入方、以及将来 T6 的宿主。**不提供环境变量或命令行开关**：它们由用户控制，等于给受管来源留后门。

`skipUserConfig` 不跳过受管来源——它不是用户配置。

### 结构

```json
{
  "version": 1,
  "permission": {
    "disallowedTools": ["WebFetch", "Bash"],
    "allowedModes": ["build", "plan", "edit"]
  }
}
```

- `version`：必填，目前只接受 `1`。
- `permission.disallowedTools`：可选。按工具名整工具禁用，不支持 `工具(内容)` 形式。字符串去首尾空白后不能为空。
- `permission.allowedModes`：可选。取值限于 `plan`、`build`、`edit`、`guarded`、`yolo`；至少一项；`auto` 尚未实现，不接受。
- 两项都省略的受管文件等于“本机受管，但暂无限制”。

### 有效与无效

| 情形 | 处理 |
| --- | --- |
| 文件不存在 | 没有 `managed` 来源，一切照旧 |
| 不是合法 JSON；`version` 缺失或不是 `1`；已知键的类型不对；列表里有空项或不认识的取值 | **无效**，创建应用时抛错，指明路径与原因 |
| 出现不认识的键 | 忽略该键，记一条警告 |

忽略不认识的键是为了升级：管控平面新增一类限制时，旧版客户端不应因此无法启动。它只能让旧客户端“少执行一类新限制”，削弱不了已有的限制；这类设备由最低客户端版本与模型网关把关。

**受管文件只读取，任何情况下都不写回。**

## 配置工厂的接口变化

`ConfigFactoryOptions` 新增 `managedConfigPath?: string`。`ConfigResult` 新增 `managed` 字段，三种状态：

```ts
managed:
  | { status: "absent" }
  | { status: "active"; path: string; policy: ManagedPolicy }
  | { status: "invalid"; path: string; reason: string };
```

每次 `createConfig` 调用同步读一次，不缓存，与其他来源一致。`createConfig` 自身不因无效文件抛错——它有三十多处调用，其中一些只需要默认的存储目录。拒绝启动发生在创建应用的那一步。

导出一个轻量的读取函数给 CLI 的参数校验使用，避免为此装配整份配置。

## 判定顺序

`checkPermission` 开头新增两步，其余不变：

```text
解析能力
① 工具在受管禁用列表里 ──────────────────────────► deny   rule.managed.deny
② 当前模式不在受管允许列表里 ── 以回退模式继续下面的判定
③ 以下与上游相同：Plan 进入/退出闸门、requiresUserInteraction、
   guarded 单次确认、yolo/guarded 放行、disallowedTools、项目 deny/ask/allow …
```

- ① 排在 Plan 闸门之前，这样管理员需要时可以禁用 `EnterPlanMode` 本身。`checkAlwaysAsk` 由同一函数的后段调起，自然被 ① 覆盖。
- ② 的做法是替换本次判定所用的 `mode`。下游（含 Plan 内补回的放行、`checkEditMode`、`checkBuildMode`）看到的都是回退模式，因此一处生效、处处生效。
- 受管禁用只比工具名，与现有 `disallowedTools` 的比较方式相同；不支持 `工具(内容)` 形式的规则。
- 规则号用新的 `rule.managed.deny`，不复用任何现有规则号：下游按规则号字面判断是否放宽。

## 启动处的执行

- **默认模式**：`resolveAppRuntimeConfig` 解析出的模式（宿主传入 → 项目偏好 → 配置）若不在允许列表里，换成回退模式，并记一条警告。
- **CLI `--mode`**：取值不被允许时报错退出，说明它被组织禁用。**`--prompt` 的默认模式是 `yolo`**：`yolo` 不被允许且调用方没有显式给出 `--mode` 时同样报错退出，提示改为指定一个允许的模式，而不是悄悄换成别的模式去执行。
- **项目记忆代理**：沿用主运行时的受管策略，不再使用无限制的默认配置。

## 入口处与界面公布（T2）

T3 只保证“会话即便处在被禁的模式里，工具调用也按回退模式判定”。运行中的会话仍然可以被切换进被禁的模式：菜单、快捷键、协议命令、终端界面都接受它。界面于是显示着 `yolo`，实际按 `build` 执行，用户无从知道。本节让运行时不再进入被禁的模式，并把被禁的模式告诉界面。

### 规则

1. **执行状态只有一个写入点。** 会话的模式与 Plan 开关都经 core 的 `applyRuntimeExecutionState` 修改，再落盘、发 `SessionModeChanged`。所有入口都汇到这里：应用的 `setMode`、协议的 `switchCollaborationMode` 与旧协议的切换、每条输入自带的模式与 Plan、创建会话时带的配置、`EnterPlanMode` 工具。唯一的例外是同步的 `updateConfig`，工作流的子运行时用它固定 `yolo`。
2. **显式切换被拒绝。** 用户当下要求切到一个被禁的模式——或者要在 Plan 被禁时开启 Plan——写入点抛出 `ManagedPolicyModeError`，消息写明是哪个模式、被谁禁用、允许的有哪些。会话的状态不变，也不发事件。`EnterPlanMode` 同样被拒绝，模型会把原因告诉用户。
3. **随请求携带的声明换成回退模式。** 创建会话的配置、每条输入自带的模式与 Plan、目标里冻结的模式，都是随别的请求一起送来的状态声明，不是一次切换。它们不被允许时按回退模式生效，**请求本身不失败**。理由见下。
4. **运行时内部的缺省值按回退模式。** 群任务、独立会话控制、工作流子运行时内部固定的 `build` 或 `yolo` 属于这一类，不是用户的选择。
5. **向界面公布被禁的模式。** 会话快照的 `config` 增加 `managedAllowedModes`，取值就是受管文件的 `permission.allowedModes`。没有受管限制，或者策略没有这个键时，字段不出现，界面照旧。

第 3 条为什么不直接拒绝：

- 目标（Goal）在提交时冻结了执行模式。策略生效之后恢复一个旧目标，每一轮都会带着被禁的模式；如果拒绝，这个目标既跑不动也压缩不了，用户没有出路。
- 桌面的新任务草稿可能在界面得知策略之前就带着被禁的模式（“最近使用”记在上次）。回退之后，用户这一条照常发出，界面拿到快照就把草稿改成会话当前的模式。
- 新旧版本混用（远端工作区的 Host 与客户端版本不同）时，旧界面不知道有限制。静默按回退模式执行比每条输入都报错更可用，也不放宽任何权限。

创建会话时带的配置（包括其中的 `guarded`）属于这一类。上游规定 `guarded` 应用失败时整个创建失败，那说的是失败；被策略禁掉不是失败，而是一条有限制的规则：会话照常创建并按回退模式起步，界面随即从快照里拿到策略，把草稿改成会话当前的模式并标出原因。用户发送之前看到的就是最终的模式。

### 写入点的判定

```text
解析出下一个状态 next
next 与当前相同 ──────────────────────────────► 原样返回（同值重申不报错）
声明的策略是“拒绝”且 next 被禁 ───────────────► 抛出 ManagedPolicyModeError，状态不变
声明的策略是“回退”且 next 被禁 ── next.mode ← 回退模式；Plan 被禁时 planEnabled ← false
落盘 → 更新内存 → 发 SessionModeChanged（next 与回退前相同时不发）
```

- “被禁”的意思：`mode` 不在允许列表里，或者要开启 Plan 而 `plan` 不在允许列表里。策略没有 `allowedModes` 时什么都不禁。
- 回退模式沿用 T3 的规则：`build`（若被允许），否则允许列表里最严格的那个。
- 没有受管限制时不做判定，走的路径与改动前逐行相同。

### 不经过写入点的两处初始状态

会话的初始模式在创建应用时已经按回退模式处理（见“启动处的执行”）。还有两处初始状态不经过写入点：

- **恢复时的 Plan 开关。** 如果上次退出时开着 Plan，恢复后 Plan 仍然开着，即使策略此时已经禁了 Plan。这一点不处理——Plan 是只读的，开着它不会放宽任何权限，用户随时可以关掉。
- **子代理的初始模式。** 子运行时按配置里的 `permissionMode` 起步（`resolveSubagentPermissionMode`），不经过写入点。如果配置要的是被禁的模式，子会话带着它运行。它的工具调用走父会话的同一个权限判定，按回退模式处理（T3），所以不放宽权限；子代理的界面上也没有模式选择器，不存在“显示着被禁的模式”的问题。要不要在创建子运行时那一处也换成回退模式，**待定**：那一处逻辑细、已有自己的测试，这次没有碰。

### 协议

`SessionConfigState`（`packages/shared/src/zcode-protocol-v4/session-config.ts`）新增可选字段：

```text
managedAllowedModes?: ("plan" | "build" | "edit" | "guarded" | "yolo")[]
```

- 必须是可选的：旧快照、旧发送端都没有这个键，缺省的含义是“不受限”。
- 由 `getSessionConfigSeed` 写入，与 `mode`、`planEnabled` 是同一个来源（应用里的那份策略）。它不是事件带出来的事实，重放的日志值不覆盖它。
- 改动前后对照：没有受管限制时，种子、快照、增量与改动前逐字节相同。

不放进旧协议的设置状态（`zcodeSessionSettingsStateSchema`）。它的每一层都是 `strict`：新 CLI 一旦多发一个键，旧桌面端会把整条 `state.updated` 丢掉，模型与模式的更新一起失效。v4 链路上的桌面与手机不读那份状态。

### 两种链路上的事件顺序

```text
应用的策略（创建应用时读受管文件，之后不变）
  │
  ├─ 桌面 desktop-continuous：订阅时种子写入 config.managedAllowedModes
  ├─ 手机 web-remote-replayable：冷恢复后种子写入，之后是同一份快照
  │     两种链路读到的都是快照里的同一个字段，没有第二条通道
  ▼
界面：菜单按它禁用候选；草稿里的模式不被允许时改成会话当前的模式

显式切换到被禁的模式 → 写入点拒绝 → 命令失败（reasonCode 为 policy.managedModeDisabled）→ 会话状态、快照、修订号都不变
```

### 验证记录（T2，2026-11-24）

环境：macOS，Node 24.14.0，上游 `a4b44451` 加 T1、T3 的三个提交与本次改动。先写、确认在实现之前失败的有：core 的 9 个用例（同文件另外 4 个验证的是不受限时的原有行为，本来就通过），以及 bootstrap 应用层的 4 个。bootstrap 里关于种子的 5 个用例写在实现之后，没有经历“先失败”。

**测试**

| 包 | 范围 | 结果 |
| --- | --- | --- |
| core | 全包 | 351 个文件全部通过；5851 个通过，21 个跳过，0 个失败（含本节的 13 个） |
| bootstrap | `managed-mode-entrypoints`、`managed-policy-app`、`v4-native-model-config` | 13 + 10 + 22 个通过。前者用真实应用（`managedConfigPath`）和一个真实的网关钩子读种子 |
| bootstrap | 整包 | 285 个文件：278 个通过，2 个跳过，5 个失败。其中一个由本节改动带来，见下；其余四个重跑后通过 |
| cli | 整包 | 556 个用例：550 个通过，6 个失败，与基线是同样的 6 个 SEA 工具缓存用例 |

- 整包里由改动带来的那一个：`v4-native-model-config` 的既有用例断言 `setExecutionState` 的调用参数。创建会话时带的模式现在声明按回退模式处理，调用多了第三个参数，用例的期望随之更新，用例验证的行为没有变。
- 另外四个：`dynamic-mcp-config` 是上游既有失败；`v4-gateway`、`protocol-unbound-resume`、`workflow-fault-matrix.retry` 在整包运行时分别是超时与计数断言，机器当时负载在 15–24 之间，单独重跑全部通过。
- 界面那一侧的浏览器验收见 [docs/ui/managed-mode-selector.md](../../../../docs/ui/managed-mode-selector.md)。

**类型检查、Lint 与架构**

- CLI 工作区 `turbo run typecheck`：34 个任务全部通过。
- 仓库根 `pnpm typecheck`：通过。
- 仓库根 `pnpm lint`：537 个警告、0 个错误，与上游基线数量相同；本次改动的行上没有 `react/exhaustive-deps` 或 `react/rules-of-hooks` 的诊断。
- `pnpm architecture:check --changed`：通过。登记了两条 `unmanaged-new-file` 例外，理由写在 `architecture-policy.yaml` 里：新文件 `useManagedModePolicy.ts` 落在未受管的 `ui` 模块；`execution-state.ts` 是上游同步引入的文件，按规则一旦被本地修改就不再享受上游准入。

**类型检查这次抓到的问题，测试抓不到**

第一轮有 6 处类型错误，全部只在类型检查里出现：`SessionFacade` 的返回类型还没声明新加的两个方法；面板块引用的回调声明在后面，运行时会直接报“声明前使用”——浏览器验收挂载的是菜单组件，碰不到面板这一层。教训与 T1 那次相同：改完先跑类型检查，再跑测试。

**没有做的**

- 真实 Agent 进程加真实受管文件的协议级联调没有做：往协议入口传受管文件路径的选项还没有（T6 的宿主会需要），受管文件的默认位置又要管理员权限。
- 终端界面的 `/mode` 列表与循环切换没有做，见“非目标”。
- 子代理的初始模式不经过写入点，见上，处理方式待定。
- 桌面全链路的人工验证没有执行，步骤在界面规格的末尾。

## 验收

CLI 测试（各包自己的测试套件）：

1. `ConfigScope.Managed` 存在，优先级高于 `Cli`。
2. 没有受管文件时，`createConfig` 的结果与改动前逐项相同；`managed.status` 为 `absent`。
3. 受管文件合法时，`managed.status` 为 `active`，路径与策略内容正确。
4. 受管文件存在但无效的每一种情形，`managed.status` 为 `invalid`，`reason` 含原因；`createConfig` 不抛错。
5. 不认识的键被忽略，策略的其余部分照常生效。
6. `managedConfigPath` 选项生效；`skipUserConfig` 不影响受管来源。
7. 读取受管文件前后，文件内容与修改时间不变。
8. 默认路径按平台解析正确（纯函数测试，覆盖三个平台）。
9. 受管禁用的工具在 `build`、`edit`、`yolo`、`guarded`、`guarded` 加 Plan、Plan 六种情形下都得到 deny，规则号是 `rule.managed.deny`。
10. 受管禁用排在 guarded 的危险命令单次确认之前——结果是 deny 而不是 ask。
11. 受管禁用不被项目 `allow`、会话授权、alwaysAsk 路径解除。
12. 工具名之外的匹配不成立：受管只写了 `Bash` 时，别的工具不受影响；受管文件不支持内容形式的规则（写成 `Bash(git:*)` 时该文件无效，因为该键只接受已经去掉规则括号的工具名形式）。
13. `allowedModes` 不含 `yolo` 时，`yolo` 会话里的普通工具调用按 `build` 判定（询问而不是放行）；`allowedModes` 不含 `guarded` 时同理；`allowedModes` 不含 `build` 时回退到允许列表里最严格的模式。
14. `allowedModes` 未设置时，判定的所有分支与改动前一致——特别地，普通 `disallowedTools` 在 `yolo` 下仍被越过（沿用现有测试）。
15. 默认模式不被允许时，`resolveAppRuntimeConfig` 换成回退模式。
16. 受管文件无效时，创建应用抛出含路径与原因的错误。
17. `--mode` 取值不被允许时，CLI 报错退出；`--prompt` 在 `yolo` 被禁而未显式给出 `--mode` 时报错退出，不悄悄换模式。
18. 项目记忆代理的工具执行器拿到的是主运行时的受管策略。

入口处与界面公布（T2）：

19. 没有受管文件，或者策略没有 `allowedModes` 时，`getSessionConfigSeed` 不带 `managedAllowedModes`，快照的 `config` 里也没有这个键。
20. 策略有 `allowedModes` 时，种子的 `managedAllowedModes` 与它逐项相同；`seedConfig` 把它写进 `config`，重复应用结果不变。
21. 策略不允许 `yolo` 时，`setMode("yolo")`、协议命令 `switchCollaborationMode` 被拒绝，错误指明 `yolo` 与允许的模式；会话的模式不变，也没有新的事件。
22. 策略不允许 `yolo` 时，允许的切换（例如 `build` → `guarded`）照常成功。
23. 策略不允许 `plan` 时，`EnterPlanMode` 被拒绝，Plan 保持关闭。
24. 按“回退”写入的请求不被允许时得到回退模式：`allowedModes` 含 `build` 时落到 `build`；不含 `build` 时落到允许列表里最严格的那个。Plan 被禁时开启 Plan 的请求得到 `planEnabled: false`。
25. `updateConfig` 写入被禁的模式时得到回退模式。
26. 同值重申不报错，也不发事件。
27. 没有受管限制时，以上每一个入口的结果都与改动前一致。

人工验证：

- CLI：以 `yolo` 启动，受管文件禁用某个工具，实际调用它，确认被拒绝且提示来自组织策略；删掉受管文件后同一操作恢复上游行为。
- 桌面与界面：步骤见 [docs/ui/managed-mode-selector.md](../../../../docs/ui/managed-mode-selector.md) 末尾。本规格在桌面形态下的效果（会话即便处于被禁模式也不放宽）在那一组步骤里一并验证。

## 验证记录（2026-11-24）

环境：macOS，Node 24.14.0，上游 `a4b44451` 加本规格的改动。每个测试都先写、确认在实现之前失败，再实现到通过。

**测试**

| 包 | 范围 | 结果 |
| --- | --- | --- |
| contracts | 全包 | 45 个文件、352 个通过（含本规格的 7 个） |
| adapters | `managed-config`、`config` | 106 个通过（含本规格的 26 个）。整包的失败仍只有 `mcp.test.ts` 与 `preinstalled-tools.test.ts`，与上游相同 |
| core | `permission-managed-policy`、`permission-service` | 91 个通过（含本规格的 19 个） |
| bootstrap | `managed-policy-app`、`runtime-config` | 53 个通过（含本规格的 10 个） |
| cli | `cli.unit.test.ts` 中本规格的 3 个 | 3 个通过 |

**类型检查与 Lint**

- CLI 工作区的 `turbo run typecheck`：34 个任务全部通过。`pnpm --dir apps/zcode-cli typecheck` 在本机跑不起来（嵌套工作区里没有装 turbo），这里用的是仓库根目录的 turbo。
- CLI 整体 Lint：0 个错误。落在本规格改动文件上的 5 条警告都是上游已有的。
- 仓库根 `pnpm lint`：537 个警告、0 个错误，与上游基线相同。
- `pnpm architecture:check --changed`：通过。新文件 `managed-config.adapter.ts` 按现有先例登记在 `architecture-policy.yaml` 的 `exceptions` 里。

**与本规格无关的既有失败**（都在未改动的代码上对照过）

- adapters：`mcp.test.ts` 16 个用例、`preinstalled-tools.test.ts` 1 个。
- core：`subagent-cold-resume.test.ts` 间歇失败。未改动时 10 次失败 3 次，带上本改动 10 次失败 2 次。
- bootstrap：`dynamic-mcp-config.test.ts`、`session-control/standalone-tui-approval.e2e.test.ts`，未改动时三次运行都失败。

**没有做的**

- 验收第 18 条（项目记忆代理沿用受管策略）没有自动化测试：那个执行器没有现成的测试入口。改动只有一行，由类型检查保证，**未经运行时验证**。
- 两条人工验证都**没有执行**。受管文件的默认位置要管理员权限才能写入，这次没有在系统位置放置文件。需要由有管理员权限的人按下面的步骤做。

```bash
# 1. 放一份禁用 WebFetch、禁止 yolo 的受管文件（macOS；需要管理员权限）
sudo mkdir -p "/Library/Application Support/ZCode"
printf '%s\n' '{"version":1,"permission":{"disallowedTools":["WebFetch"],"allowedModes":["build","plan"]}}' \
  | sudo tee "/Library/Application Support/ZCode/managed-config.json"

# 2. CLI：在一次性的目录里运行，让模型抓取任意网页。应当被拒绝，提示它被组织的策略禁用。
#    再用 --mode yolo 试一次：应当在参数校验处报错退出。
# 3. 写入格式损坏的受管文件，再启动：应当拒绝启动并给出路径与原因。
# 4. 验证完移除受管文件，确认一切恢复上游行为。
sudo rm "/Library/Application Support/ZCode/managed-config.json"
```
