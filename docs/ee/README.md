# 企业版（ZCode-EE）改造点索引

本仓库是 ZCode 的 fork，承载企业版 ZCode-EE 的客户端改造。企业版的管控后端在另一个仓库 `ZCode-Manage`。本目录不是规格的存放处，只是索引：**规格按仓库各自的规则存放**，这里把每个改造点指向它。

## 约定

- **先写规格，再写测试，最后实现。** 根规则见 [AGENTS.md](../../AGENTS.md)；Agent 运行时的规格必须在 `apps/zcode-cli/docs/design/v2/`，见 [apps/zcode-cli/AGENTS.md](../../apps/zcode-cli/AGENTS.md)。
- **新增优先，禁用优先。** 企业能力放进独立模块；既有代码只在接缝处接线；官方功能用开关关掉，不删代码。
- **没有企业配置文件时，开源默认行为不变。** 每个改造点都要满足这一条，并用测试证明。
- **每个提交的说明写明属于哪个编号。** 每次同步上游，逐项确认是否受影响。

## 改造点

编号沿用管控后端方案文档（`ZCode-Manage/docs/enterprise-backend-features-and-language.md` 6.2 节）。行号指 v4.0.0 源码中的位置。

| 编号 | 改造点 | 规格或设计文档 | 状态 |
| --- | --- | --- | --- |
| T1 | 新增受管配置作用域，优先级高于 `Cli` | [apps/zcode-cli/docs/design/v2/enterprise-managed-policy.md](../../apps/zcode-cli/docs/design/v2/enterprise-managed-policy.md) | 已实现，有自动化测试；人工验证未做 |
| T2 | 被策略禁掉的模式在模式选择器里不可选，并标明由组织管理 | 运行时：[apps/zcode-cli/docs/design/v2/enterprise-managed-policy.md](../../apps/zcode-cli/docs/design/v2/enterprise-managed-policy.md) 的“入口处与界面公布”；界面：[docs/ui/managed-mode-selector.md](../../docs/ui/managed-mode-selector.md) | 已实现，有自动化测试（真实应用、真实网关、真实浏览器里的组件）；桌面全链路的人工验证未做。终端界面的 `/mode` 列表与循环切换还没做，运行时的拒绝对它已经生效 |
| T3 | 受管 deny 先于模式放行；`--mode` 取值受策略约束 | 同 T1 | 已实现，有自动化测试；人工验证未做 |
| T4 | 企业登录适配器，CLI 与桌面共用 | 待写 | 未开始 |
| T5 | 企业模型接入类型 | 待写。与官方“团队套餐”代码的处理方式有关，尚未定 | 未开始 |
| T6 | 启动引导、策略拉取、心跳与生效版本上报 | 待写 | 未开始 |
| T7 | 用量与审计事件本地排队上报 | 待写 | 未开始 |
| T8 | 解锁打包版的更新源 | 待写 | 未开始 |
| T9 | 把写死的服务地址改为可配置 | 待写 | 未开始 |
| T10 | 桌面遥测开关与上报端点可配置 | 待写 | 未开始 |
| T11 | MCP、技能、插件增加受管作用域 | 待写 | 二期 |
| T12 | 会话归档导出接口 | 待写 | 二期 |
| T13 | 高危操作审批转发 | 待写 | 二期 |
| T14 | 企业构建禁用官方套餐、购买、额度面板与账号家族界面 | 待写 | 未开始 |

## 对客户端的硬性要求

来自管控后端 Step 1 的规格（`ZCode-Manage/specs/step1-contracts-and-dev-stack.md` 第 4 节）。漏了不会报错，但功能是坏的。

- **授权请求必须带 `prompt=consent`。** 这是 OpenID Connect 对申请 `offline_access` 的规定。不带的话，颁发者不报错，只是静默去掉这个范围：拿不到刷新令牌，访问令牌 15 分钟后到期就得重新登录。
- 登录是授权码加 PKCE，公共客户端。
- 颁发者公布的端点地址都由配置派生，客户端用发现文档给出的地址即可，不必自己拼。
