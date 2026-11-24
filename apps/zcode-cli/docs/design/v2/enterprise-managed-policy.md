# 企业受管策略：受管配置作用域

> 状态：T1 已实现并经自动化测试验证（2026-11-24）；两条人工验证尚未执行，见末尾的验证记录。T3（权限判定顺序、模式约束）的规则也写在这里，它的实现随后提交。
> 对应企业版改造点 T1（受管配置作用域）与 T3（权限判定顺序、`--mode` 取值受策略约束）。改造点编号见企业版方案文档 6.2 节，索引见 [docs/ee/README.md](../../../../docs/ee/README.md)。
> 本规格只覆盖 Agent 运行时（CLI 与 app-server）。设置界面的只读展示（T2）另见 T2 规格；策略的拉取、验签与写入（T6）不在此列。

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

## 非目标

- **策略的分发与可信性。** 本规格不给安全性保证：受管文件所在位置由操作系统权限保护，但没有签名校验，也没有“本机应当有策略”的登记。能获得管理员权限的人可以删除或改写它。验签与生效版本回报属于 T6，模型网关对未回报设备的拦截属于纵向链路 2。
- 通用的“逐键钉住任意配置键”。本规格的受管键都走专门的通道，不需要通用合并。第一个需要通用钉住的键出现时（C5 的只读受管 Provider）再实现，并遵守下面“产品规则”第 6 条。
- MCP、Hook、插件的受管范围（T11，二期）。
- 切换模式时在入口处拒绝。本规格只在判定处与启动处执行；TUI 菜单、协议命令、桌面界面的拒绝与只读展示属于 T2。

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
| 模式是否允许的判定 | contracts 的纯函数 | 判定处与启动处共用同一份规则，不各写一遍 |
| 权限判定 | `PermissionService.checkPermission` | 仍是唯一的判定点 |

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
  | { status: "active"; path: string; policy: ManagedPolicy; unknownKeys: readonly string[] }
  | { status: "invalid"; path: string; reason: string };
```

每次 `createConfig` 调用同步读一次，不缓存，与其他来源一致。`createConfig` 自身不因无效文件抛错——它有三十多处调用，其中一些只需要默认的存储目录。拒绝启动发生在创建应用的那一步（`assertManagedPolicyUsable`），并且排在任何会话、模型或存储被初始化之前。

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

- **受管文件无效**：创建应用时拒绝启动（T1，本提交）。
- **默认模式**：`resolveAppRuntimeConfig` 解析出的模式（宿主传入 → 项目偏好 → 配置）若不在允许列表里，换成回退模式，并记一条警告。
- **CLI `--mode`**：取值不被允许时报错退出，说明它被组织禁用。**`--prompt` 的默认模式是 `yolo`**：`yolo` 不被允许且调用方没有显式给出 `--mode` 时同样报错退出，提示改为指定一个允许的模式，而不是悄悄换成别的模式去执行。
- **项目记忆代理**：沿用主运行时的受管策略，不再使用无限制的默认配置。

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

人工验证：

- CLI：以 `yolo` 启动，受管文件禁用某个工具，实际调用它，确认被拒绝且提示来自组织策略；删掉受管文件后同一操作恢复上游行为。
- 桌面：由 T2 的 E2E 覆盖界面的只读表现；本规格在桌面形态下的效果是“会话即便处于被禁模式也不放宽”，在 T2 的用例里一并验证，或另行记录。

## 验证记录（2026-11-24，T1）

环境：macOS，Node 24.14.0，上游 `a4b44451` 加本提交。每个测试都先写、确认在实现之前失败，再实现到通过。

**已由本提交满足的验收项**：1–8、16，第 14 条里“模式不受限制”的部分由本提交的测试保证。其余各项（9–13、14 里受限的部分、15、17、18）属于 T3，随它的提交验证。

**测试**

| 包 | 范围 | 结果 |
| --- | --- | --- |
| contracts | `managed-policy`（T1 的 2 个）、全包 | 全包 347 个通过 |
| adapters | `managed-config`（26）、`config` | 106 个通过 |
| bootstrap | `managed-policy-app`（T1 的 4 个）、`runtime-config` | 47 个通过 |

**类型检查与 Lint**

- CLI 工作区的 `turbo run typecheck`：34 个任务全部通过。`pnpm --dir apps/zcode-cli typecheck` 在本机跑不起来（嵌套工作区里没有装 turbo），这里用的是仓库根目录的 turbo。
- CLI 整体 Lint：0 个错误，87 个警告，与上游相同。仓库根 `pnpm lint`：537 个警告、0 个错误，与上游基线相同。
- `pnpm architecture:check --changed`：通过。新文件 `managed-config.adapter.ts` 按现有先例登记在 `architecture-policy.yaml` 的 `exceptions` 里。

**与上游对照**：adapters 整包失败的仍只有 `mcp.test.ts` 与 `preinstalled-tools.test.ts`，bootstrap 与 core 的既有失败、间歇失败见管理端的 CLI 工作区基线文档；这些都未包含在本提交的范围内，原因相同。

**人工验证**

与 T2 的界面验证一起做，或另行记录：

```bash
# 1. 放一份格式无效的受管文件（macOS；需要管理员权限），再启动 ZCode：应当拒绝启动并给出路径与原因。
sudo mkdir -p "/Library/Application Support/ZCode"
printf '%s\n' '{"version":7}' | sudo tee "/Library/Application Support/ZCode/managed-config.json"

# 2. 验证完移除受管文件，确认一切恢复上游行为。
sudo rm "/Library/Application Support/ZCode/managed-config.json"
```
