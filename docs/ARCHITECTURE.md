# Portage 架构设计方案 v1.0

更新于 2026-11-18。本方案为第一版冻结架构，与 PRODUCT / DOMAIN / UX / MVP 及 HTML 原型对齐。覆盖跨来源会话、房间协作和个人到团队的演进。默认参数是可调建议，§10 附实测数据。当前实现：TypeScript 单体 Daemon（MemoryBus + SQLite 快照 + EventLog/SSE）、Codex / Claude Code 原生回合适配器（会话记录发现、headless resume 提交、原生记录回读与关联）、CLI 进程发现与 FileInbox 注入、MCP 桥接（agent 读取并产生 `agent_ack`、回复沿用 trace、报告忙闲）、正式 Web UI；向交互中的 PTY / IDE / App 直接注入待实现（占用时 held 等待释放）。

图中方括号代表对象或模块，`→` 表示有方向的连接，`↔` 表示双向通信，分叉表示独立去向。箭头旁标注传递的内容或触发条件；部署在同一进程内的模块也保持这些接口边界。

## 1. 产品责任

Portage 统一管理不同来源的原生 agent session，让用户直接对话、组织房间、传递信息与产物，并追踪每次消息传递。

原生宿主负责模型调用、推理、工具执行与自身上下文。Portage 负责接入、寻址、权限、上下文包装、通信调度、记录同步与可观测性。不改写各 session 已有身份与正在干的活；统筹者仅作唤醒与连线路由，具体找谁帮忙由消息内容与协作约定指导。

| 用户需求 | 架构落点 |
| --- | --- |
| 按 Codex / Claude，再按 App / VS Code CLI / Terminal 查看 | Registry 的 provider、harness、host 分组 |
| 直接与已有 session 对话 | Session、NativeBinding、Adapter |
| 拖动 session 组成聊天室 / team | Conversation、Membership、Subscription |
| 配置统筹者、读写范围与协作约定 | PolicyDocument、RoomPolicy.coordinator、PolicyService |
| enable / disable 任意 session 的通信 | 总开关与每次读写、投递检查 |
| session 和记录的增删改查 | 管理 API、能力声明、版本与作用范围 |
| 实际走指定 terminal session | 原生身份、endpoint、epoch 校验与提交证明 |
| 展示工作、未唤醒、排队和信息流 | 同一事件流的房间、链路和时间线投影 |
| 多层 MD、最高层内容进入每次 query | 版本化 PolicyDocument 与 ContextCompiler |
| 控制 agent 沟通开销 | WakePolicy、Budget、DeliveryScheduler |

## 2. 名词

| 名词 | 含义 | 示例 |
| --- | --- | --- |
| Provider | 原生产品提供方 | Codex、Claude |
| Harness | 管理 agent 上下文、模型和工具的运行宿主 | Codex CLI、Claude Code、App |
| Endpoint / Surface | 当前可连接的物理或协议入口 | PTY、App bridge、IDE 面板 |
| Session | 持久的原生对话身份 | Codex Terminal 的某个 native session |
| NativeBinding | Session 到实际原生会话及入口的可验证绑定 | 原生 ID、endpoint、连接代次 epoch |
| Participant | 收发消息及加入房间的身份 | 用户，或代表 session 的 agent |
| Handle | 可寻址别名，内部解析到稳定 ID | `@codex-review` |
| Conversation | Portage 保存的通信空间 | 私聊或房间 |
| Room / Team | 多成员 conversation，附带规则与可选统筹者 | Portage 开发室 |
| Membership | 某身份在房间中的成员关系 | 可读、可写、可管理配置 |
| Thread | 房间中一个主题的消息分支 | 适配器评审 |
| Message | 一份逻辑内容及其引用 | 请求、回复、文件说明 |
| Delivery | 一条消息向一个接收 session 的逻辑投递 | 群消息给 A、B 各有独立 Delivery |
| Inbox / 消息队列 | 尚待投递的工作，有序等待接收方 | A 忙时排队，恢复就绪后提交 |
| Bus | 寻址、收发、分发、订阅的统一服务边界 | UI、MCP、连接器共用应用 API |
| EventLog | 持久记录消息、配置和投递变化 | 谁在何时把什么送到哪里 |
| Trace | 一次交互及后续通信的因果链 | 用户 → 统筹 session → 成员 session → 汇总 |
| Artifact | 有版本、来源及访问权限的产物 | 文件、图片、报告、结构化结果 |
| Projection | 从持久记录生成的查询视图 | 来源树、房间状态、时间线、链路图 |

Session 对应原生对话身份，Thread 对应 Portage 房间中的主题。一个 session 可以参加多个房间和 thread。VS Code 中的 CLI 与普通 terminal 可以拥有相同 harness。发现同一原生 session 的多个入口时，按可验证原生身份关联，为自动投递选择唯一活动入口。

对象关系链路：

```text
[Workspace 工作区]
    ├──拥有──→ [Session 原生会话身份]
    │               ├──绑定──→ [NativeBinding] ──选择活动入口──→ [Endpoint]
    │               └──代表──→ [Participant agent 身份]
    │                                 │
    │                           [Membership]
    │                                 │ 加入 / 退出
    │                                 ▼
    └──包含──→ [Conversation 私聊 / 房间] ←──加入── [Participant 用户身份]
                    │ 可选 coordinator（路由，非工种）
                    │
                    ├──组织主题──→ [Thread] ──归集──→ [Message]
                    └──保存内容────────────────────→ [Message]
                                                       ├──引用──→ [Artifact 及版本]
                                                       ├──分发──→ [Delivery A] → [Session A]
                                                       └──分发──→ [Delivery B] → [Session B]

[Handle 别名] → [Participant] → [Session] → [NativeBinding] → [Endpoint]
```

同一个 Participant 可以通过不同 Membership 加入多个房间。Message 必须属于 Conversation，可选择属于其中一个 Thread；图中的两个 Message 标记指向同一类内容对象。

| 关系 | 设计含义 |
| --- | --- |
| Workspace 包含多个 Session | 会话属于一个工作区，身份跨进程重启保持 |
| Session 通过 NativeBinding 连接 Endpoint | 同一原生会话可以有多个可验证入口，自动投递使用唯一活动入口 |
| Session 对应一个 agent Participant | 成员关系和消息使用 Participant 身份，输入投递解析到对应 Session |
| Participant 通过 Membership 加入 Conversation | 一个身份可以加入多个房间；各房间保存权限，不设工种角色 |
| Conversation 包含 Thread 和 Message | Thread 组织主题，Message 保存具体内容和来源 |
| Message 分发为多个 Delivery | 每位接收 Session 独立排队、确认和处理失败 |
| Message 引用 Artifact | 同一产物可以被多条授权消息引用，并保留版本与来源 |

寻址时，Handle 先解析为 Participant，再找到 Session、有效 NativeBinding 和活动 Endpoint。读取历史时，从 Conversation、Thread 和成员权限确定可见消息。

## 3. 模块架构

首版采用 TypeScript 模块化单体与 SQLite。本地连接器可以与 daemon 同进程，模块通过明确应用接口协作。持久事务提交后通知事件订阅者。

### 3.1 发送主链路

```text
[用户 UI] ──────────┐
[Agent MCP] ────────┼──→ [Facade / Bus API：认证与统一应用入口]
[企业聊天 Gateway] ─┘                       │
                                           ▼
                           [Messaging：接收、寻址、分发]
                                │                  ↕ 查询与校验
                                │       [Registry + Conversations + Policy]
                                │         会话入口 / 成员关系 / 权限与开关
                                ▼
                 [Store：Message + Delivery + Event + Outbox 同事务落库]
                    │              │                          │
                    │              │                          └──→ [accepted 回执]
                    │              └──事件──→ [Projections] ──→ [UI / 事件订阅者]
                    ▼
          [Delivery 持久队列：按接收 Session 分开排队]
                    │ 提交后通知 / ready / 重连 / 定时到期
                    ▼
          [DeliveryScheduler：调度与投递前复查]
                    ├──暂不满足条件──→ [held + 原因] ──条件恢复──→ [重新调度]
                    │
                    ▼ 可投递
          [ContextCompiler：编译本次 query] ←── [适用 MD 约束 / 授权引用]
                    │                              ↑
                    │                         [Artifacts 内容与版本]
                    ▼
          [Adapter：核对绑定、原生输入锁、实际提交]
                    │
                    ▼
          [指定原生 Session：App / IDE / Terminal]
                    │ 提交凭据 / 原生回复 / 状态
                    └──────────────────────────────→ [记录返回链路，见 3.2]
```

Messaging 调用身份、成员与策略服务完成检查；通过后才进入原子事务。附件先由 Artifacts 保存，Message 引用内容版本。Store 提交后返回 accepted，事件通知可以唤醒调度器；重启时调度器仍能从持久 Delivery 恢复工作。图中的队列首版由 SQLite 表实现。

### 3.2 原生记录返回链路

```text
[原生 Session：输入回显 / 回复 / 运行状态]
                  │ 原生事件 / 增量日志
                  ▼
[Adapter：按 cursor 读取，保留 nativeSessionId / nativeEventId]
                  │
                  ▼
[Store：去重，保存 NativeEvent、同步游标和缺口]
    ├──有可靠关联──→ [Message / DeliveryReceipt：补充对应消息与投递凭据]
    ├──记录与事件──→ [Projections]
    │                    ├──→ [对话历史]
    │                    ├──→ [成员状态 / 队列 / 同步状态]
    │                    └──→ [Trace 信息流 / 时间线]
    │                                   │ 增量订阅
    │                                   ▼
    │                            [用户 UI / 授权调用者]
    └──显式转发规则 + 授权──→ [Messaging] ──→ [新的 Message / Delivery]
```

原生输入回显、回复和状态保留原生来源与游标。能核对注入关联 ID 时，将记录关联到对应 Message 和 Delivery。Projections 根据同一批记录更新对话、成员状态、队列和信息流。

### 3.3 管理与查询链路

```text
[UI / MCP] → [Bus API：身份与权限检查]
                   ├──会话管理──→ [Registry] → [Adapter] ↔ [原生宿主]
                   ├──房间成员──→ [Conversations]
                   └──规则发布──→ [Policy]

[Registry / Conversations / Policy 的变更与操作结果]
        └──→ [Store + Event] → [Projections] → [UI / MCP：更新后的状态]

[UI / MCP：历史 / 状态 / Trace 查询]
        └──→ [Bus API：读取权限与范围] → [Projections / Store] → [授权查询结果]
```

会话管理请求进入应用 API 后交给 Registry，原生创建、恢复或重命名由对应 Adapter 执行。房间与成员变更交给 Conversations，规则变更交给 Policy。操作结果及事件持久化后，再更新查询视图。

历史、状态和链路查询通过应用 API 检查访问范围，再读取 Projections 和 Store。UI 与 MCP 复用这些应用服务。

| 模块 | 职责 |
| --- | --- |
| registry | 发现来源、持久 session、endpoint、binding、活动入口、能力 |
| conversations | 私聊、房间、成员、thread、订阅与游标 |
| policy | 权限、通信开关、统筹者路由、唤醒、配额、协作 MD |
| context | 编译适用 MD、授权引用与原始消息，保存输入快照 |
| messaging | 幂等接收、目标解析、逐接收方 Delivery |
| delivery | 排队、ready 门控、公平调度、租约、重试、不确定结果 |
| artifacts | 流式内容存储、hash、版本、访问及目标端材料化 |
| store | 事务、索引、持久队列、事件、outbox 与原生事件去重 |
| projections | session 列表、历史、trace、状态、统计与增量订阅 |
| adapters | 各产品宿主的发现、读取、输入、生命周期及凭据 |
| facades | UI RPC、MCP、HTTP、webhook 共享应用服务 |

Bus 是上述通信服务的统一入口。按负载需要可以替换存储与队列后端，也可以把本地连接器移到设备进程。

## 4. 消息如何进入真实 terminal

以“向 Codex Terminal 的 session 1 发一条消息”为例，下图展开实际入口、等待分支和回读链路。

```text
[用户 / 其他 Session]
        │ 目标 handle + 正文 + Artifact 引用 + 幂等键
        ▼
[Bus API] → [身份 / 成员 / 通信开关 / 附件权限检查]
                       ├──不通过──→ [拒绝 + 可解释原因]
                       ▼ 通过
             [Registry：Session ID → NativeBinding → 活动 Endpoint + epoch]
                       │
                       ▼
             [Message / Delivery 持久化] ──→ [向发送者返回 accepted + messageId]
                       │
                       ▼
             [session 1 的 Inbox / DeliveryScheduler]
                       ├──busy / 离线 / 暂停 / 预算不足──→ [等待 + 原因]
                       │                                      │
                       │                                      └──条件恢复──→ [DeliveryScheduler]
                       ▼ ready 且允许投递
             [复查当前权限、原生身份与 epoch]
                       ├──已变化且不可投递──→ [held / 明确失败]
                       ▼
             [ContextCompiler] ──→ [保存实际 query 与文档版本快照]
                       │ 编译后的 query / 材料化附件
                       ▼
             [Terminal Adapter + 原生输入锁]
                       │ 实际 terminal 通道提交
                       ▼
             [Codex Terminal / 原生 session 1]
                       │
                       ├──提交凭据──→ [submitted]
                       ├──提交结果不明──→ [uncertain] ──查询 / 回读核对──┐
                       └──原生记录 / 回复 / 状态──→ [Adapter 增量读取] ←┘
                                                         │
                                                         ▼
                                  [Store 去重 + 关联 Message / Delivery + 同步游标]
                                                         │
                                                         ▼
                                  [Projections] → [对话 / 回执 / Trace 链路图]
```

accepted 表示 Portage 已持久接收，submitted 表示取得原生提交凭据。agent 的处理确认由后续可验证事件或显式回执补充。uncertain 保留在核对状态，只有证明可安全重试才重新排队。各阶段的状态分别保存，用户能看到消息停在哪里、等待什么以及已经获得哪些证明。

NativeBinding 包含产品命名空间、原生 session ID、endpoint ID、epoch。原生会话切换或进程更换时更新代次，旧投递重新检查身份。同一个原生 session 的多个入口共享提交锁。

Adapter 提供写入字节、提交输入、原生消息确认等分层凭据。UI 依次展示“已写入终端”“已提交”“原生记录已确认”等可证明事实。agent 确认处理来自显式回执或可靠原生事件。观察到输出变化时，保存其真实来源与关联强度。

每个连接中的 session 声明读取、写入、附件及管理能力。产品名称、版本和连接方式通过接入验收确定能力，UI 据此开放操作。连接故障可使写入能力临时降级，同时继续读取已有记录。

**实现（v1.0）· 原生回合**

| 环节 | 当前行为 |
| --- | --- |
| 发现 | 读取 Codex `~/.codex/sessions` 与 Claude Code `~/.claude/projects` 的会话记录：原生 ID、工作目录、最近活跃、首条真实用户输入作标题；跳过子 agent 线程与 IDE 注入上下文 |
| 就绪 | 提交前检查：会话记录被交互式进程打开（Linux 读 `/proc/<pid>/fd`，macOS 用 lsof）或刚被别人写入 → held(`attached`，附占用者)；CLI 不可用 → held(`offline`)；后台 tick 重新检查 |
| 提交 | 以该会话身份恢复一次 headless 回合，query 走 stdin；临时挂 Portage MCP 供回复；继承会话最近的沙箱 / 网络 / 权限设置。同一会话一把输入锁，不同会话并行，在途回合计入活动席位 |
| 凭据 | 进程启动 = `submitted`；回读到带消息标记的输入 = `native_confirmed`（同时核对 `uncertain`）；agent 经 MCP 读取或回复 = `agent_ack` |
| 回读 | 回合结束后按游标增量读取：输入 / 输出 / 回合边界存为 NativeEvent，关联 exact（消息标记）/ inferred（同回合输出）/ unknown；读取失败保存在同步游标上，UI 显示回读缺口 |
| 失败与控制 | 回合失败原因写入会话状态并在 UI 显示；可中断运行中的回合；改绑原生身份后 epoch +1，排队项 held(`identity_changed`)，确认后放行 |

## 5. 房间、统筹路由和唤醒

房间包含成员、thread、协作约定、默认入口、订阅与策略。拖入或选择添加 session 调用成员管理 API；退出调用离开 API，写入 `Membership.leftAt`，活动成员列表移除该身份。退出后该 session 不再接收本房间新的自动 Delivery；进行中的 Delivery 进入 held/cancelled 并保留原因。历史是否仍可读由 `historyScope` 决定。一个 session 可以加入多个房间，每次读写与投递携带具体 room。

**不设房间工种角色。** 原生 session 的身份与当前工作留在宿主上下文；Portage 只管理通信。collaboration.md 提供约束与指导（联系方式、产物格式、频率），不改写模型 persona。

房间协作拓扑 v1 冻结为两种主模式：

| 模式 | 唤醒 | 房间视图连线 | 约束 |
| --- | --- | --- | --- |
| 统筹 `coordinator` | 用户发到房间时先唤醒唯一统筹者 | 统筹 → 各成员的派发连线 | 有且仅有一位 coordinator |
| Swarm `swarm` | 默认仅 @；可选手动 | 无成员间固定连线 | 不设派发中心 |

另可选 `mentions` / `manual` 作为细项；`all` 不作为 v1 默认推荐。UI 切换模式时同步更新连线投影，不改写历史消息。

统筹模式下，用户消息写入房间历史，先唤醒 coordinator。其他授权成员可读历史。Coordinator 根据上下文决定具体分工，再通过消息或 mention 联系成员，收回产物并汇总。

```text
[用户请求] → [Room / Thread 历史：授权成员可读]
                         │ coordinator 唤醒策略
                         ▼
                 [统筹 Session]
                         │ agent 决定分工，发送定向请求
                         ▼
                 [Portage Bus：检查权限、持久分发]
                    ├──→ [Delivery A / Inbox A] → [实现 Session]
                    │                                  │ 结果 + Artifact 引用
                    │                                  ▼
                    │                            [Portage Bus] ──┐
                    │                                           │
                    └──→ [Delivery B / Inbox B] → [审查 Session] │
                                                       │ 意见   │
                                                       ▼        │
                                                 [Portage Bus] ─┤
                                                                ▼
                                                   [统筹 Inbox → 统筹 Session]
                                                                │ 汇总
                                                                ▼
                                                     [Room / Thread] → [用户]

[每条消息 / 逐接收方 Delivery / 产物来源]
          └── traceId + causalParentIds ──→ [信息流图：分发、等待、回复、汇总]
```

图中的 agent 间箭头全部经过 Portage 的权限、队列与适配器链路。不同成员是独立投递分支；一位忙碌时，另一位仍可接收。若某条下游依赖上游产物，由统筹者或发送方在产物返回后再发下一条消息——这是通信顺序，不是 Portage 分配的工种。每个下游请求引用上游消息，结果与产物同样保留因果关系。

“可读取”与“被唤醒”是两个独立出口：

```text
[房间新消息]
    ├──读取权限──→ [授权成员的历史查询 / readCursor] → [成员按需读取]
    └──唤醒策略──→ [选中的接收成员] → [逐成员 Delivery / Inbox]
                                              ├──ready + 预算通过──→ [提交原生输入]
                                              └──未满足条件──→ [排队 / held]
```

房间内定向消息沿用房间的读取范围，私聊使用独立 Conversation。自动唤醒对象由房间策略和显式目标确定。

可读范围与自动唤醒范围分别配置。每位被唤醒的接收成员拥有独立 Delivery / Inbox 与 readCursor。

统筹者在统筹模式下唯一：改任时更新 `RoomPolicy.coordinatorParticipantId`，原统筹者恢复为普通成员（无工种标签）。结构化权限控制读、写、邀请、退出、修改规则和指定统筹者，由服务端执行。用户可以委派某个 agent 调用与 UI 相同的管理 API，并受自身授权范围约束。

### 5.1 收件箱与自动轮次

```text
[Message 被接受]
    └──为每位唤醒目标创建 Delivery
            └──进入该 Session 的 Inbox（有序队列）
                    ├──ready ──→ 调度提交
                    └──busy / 离线 / 预算 / 暂停 ──→ queued 或 held（保留原因）
```

收件箱会排队：同一 Session 的待投递项按序等待，不因房间内其他成员忙而丢弃。

自动轮次预算 `rounds / max_auto_rounds`（界面如 `2/4`）：

```text
[用户消息] = 轮次 0 起点
[agent 自动互唤醒并回复] → rounds += 1
...
[rounds == max_auto_rounds] → 停止自动唤醒，Delivery held(reason=round_budget)，等待用户
```

一轮指同一 trace 上一次「自动发起的 agent→agent（或 agent→房间再唤醒）投递」。用户手动发送或「唤醒一次」不消耗该预算，或按策略单独计数（v1 默认：手动不计入自动轮次）。

关闭 session 通信时停止新的跨 session 收发与自动唤醒，已有待投递项进入 held。用户仍可按自身权限查看记录和管理设置。重新开启时校验当前成员权限、绑定代次、有效期和策略后恢复。房间暂停、订阅静默、session 总开关分别记录。

## 6. 分层 MD 与生效

文档层级采用组织 / 全局 → 工作区 → 房间 collaboration.md。个人版提供默认工作区和用户最高层 MD。**不再注入「成员角色 MD」。**

文档正文用于通信约束与指导；经过 schema 校验的 YAML frontmatter 用于服务端可执行策略。版本、修改者和实际生效结果一起保存。注入时明确这是房间约定，不覆盖原生会话已有身份。

```text
[组织 / 全局 MD] ───────┐
[工作区 MD] ────────────┼──→ [按接收者 + Conversation 选择已发布版本]
[房间 collaboration.md] ─┘                         │
                                                 ├──结构化配置──→ [Policy：权限 / 预算 / 统筹者]
                                                 │                         │ 通过才允许提交
                                                 ▼                         │
                                           [ContextCompiler] ←────────────┘
                                                 ↑
[原始 Message 正文] ─────────────────────────────┤
[授权 Artifact 引用] → [按目标能力材料化] ────────┘
                                                 │ 编译一次（短约束，非新 persona）
                                                 ▼
                         [ContextSnapshot：实际 query / revisions / hash / 注入清单]
                                                 │
                                                 ▼
                              [Adapter] → [目标原生 Session 的下一次可接收输入]
                                                 │ 提交凭据
                                                 ▼
                              [lastInjectedRevision / 生效状态视图]

[原生宿主必须重载的配置] → [适配器支持的 reload] → [nativeAppliedRevision / 待应用原因]
```

私聊按自身 Conversation 选择适用文档；房间约定只进入对应范围的 query。Artifacts 记录采用原生附件还是文件引用，ContextSnapshot 保留最终注入内容和体积，便于用户预览与事后核对。

每次经 Portage 发往原生 session 的 query，默认可贴入适用最高层 MD 与房间协作约定。原始正文与编译 payload 分开保存，转发引用原始消息，每次只编译一遍。

权限与预算取各适用层级的约束交集。下层可收窄既有范围，扩大授权需要调用者有相应管理权限。行为说明标注层级与来源；**原生宿主与模型既有角色优先**，Portage 文本只作补充约束。

```yaml
---
version: 1
wake:
  mode: coordinator   # coordinator | swarm | mentions | manual
  coordinator: session-codex-terminal-1  # mode=coordinator 时必填且唯一
  batch_window_ms: 750
  max_concurrent: 2
budget:
  agent_messages_per_minute: 12
  max_wakeups_per_trace: 20
  max_auto_rounds: 4
  max_context_bytes: 32768
---

# Portage 开发室

# 通信约定（约束与指导，不改写各 session 原有身份）

统筹者先接收用户请求，再联系需要协助的成员。
需要他人处理时明确 @ 对方。完成后附结果与产物引用。
自动讨论达到 max_auto_rounds 后等待用户恢复。
```

上述参数用于初始验证，可按房间调整。界面「2/4 自动轮次」即当前 `rounds` / `max_auto_rounds`。

**实现（v1.0）**：发布房间 collaboration.md 时，服务端用同一个解析器（`@portage/core` 的 `parsePolicyDocument`）校验策略头：只接受上面列出的键，未知键、越界值、`wake.coordinator` 不是当前成员（可写 participant id、session id 或别名）都会让整份发布失败，策略与 revision 均不变。校验通过后先应用唤醒模式与统筹者，再应用预算，最后发布 revision；策略头不进入 query，只有正文作为约束与指导注入。UI 编辑器在输入时用同一解析器实时显示「将执行的策略」或全部错误。全局 PORTAGE.md 的策略头不执行。

| 变更 | 生效时机 |
| --- | --- |
| 权限、开关、预算、统筹者 | 原子发布 revision 后，下一次读写或投递检查立即使用 |
| MD 正文（协作约束） | 下一次 query 编译时使用 |
| 当前模型正在运行的 turn | 保存待应用版本，在下一个可接收输入边界使用 |
| 原生宿主启动时读取的配置 | 按适配器显示待原生重载，调用其支持的 reload 操作 |

保存生成 draft，校验并发布生成 revision，使用 expectedRevision 处理并发冲突。每个成员显示 publishedRevision、lastInjectedRevision、nativeAppliedRevision 及 pendingReason。常规 Portage 配置通过热更新生效。

已进入原生上下文的内容保存为既有输入事实，之后的 Portage 操作使用当前权限。Portage 执行自身 API、内容和连接器访问控制，原生宿主执行其文件与网络权限。

## 7. 沟通频率与工作时间

通信频率属于 Portage 的调度范围。MD 提供协作约定，系统执行可计数的唤醒与投递限制，并解释每次等待的原因。

| 机制 | 具体行为 |
| --- | --- |
| 定向唤醒 | 新房间默认 swarm（仅 @）；开发室示例为 coordinator；另可选 mentions、manual |
| 就绪门控 | 自动输入等 ready，用户可选择适配器支持的立即输入方式 |
| 合并提醒 | 小时间窗合并唤醒，保留每条消息的 ID、顺序与回执 |
| 并发预算 | 房间自动活动席位有上限，native session 串行提交输入 |
| 速率和轮次预算 | 按发送者、房间、trace、成员对统计，达到阈值进入 held |
| 状态去噪 | 回执、状态和原生镜像事件默认更新视图 |
| 循环抑制 | 同时统计显式 causation 链和时间窗内重复往返 |
| 人工控制 | 暂停、唤醒一次、恢复、取消队列、调整预算 |

预算耗尽后保留持久记录，自动唤醒转为可恢复等待。等待原因包括 busy、disabled、room_paused、rate_limited、round_budget、offline、permission_changed、identity_changed。

活动席位依据自动 turn 与运行端完成信号计数。失联时转 unknown，租约超时可回收调度席位，原生输入锁仍按绑定与运行信号保护。工作状态来自宿主 busy 或 agent 进度上报，耗时分别统计排队、原生运行和通信等待。

**实现（v1.0）**

| 机制 | 当前行为 |
| --- | --- |
| 自动轮次 | 按 trace 计数（`traceRounds`），一条讨论刷屏不会消耗另一条的预算；用户在某条 trace 发言只重置该 trace |
| 每分钟消息 | 超出时 held(reason=`budget`)，记录 `nextAttemptAt`（窗口最早一条消息过期的时刻）；Daemon 后台 tick 在窗口重开后自动放行 |
| 单链路唤醒 | 同一 trace 上 agent 引发的 Delivery 超过 `max_wakeups_per_trace` 时 held(reason=`wakeup_budget`)；调高上限后按序放行 |
| 活动席位 | 房间内宿主报告 running 的成员数（不含接收方）达到 `max_concurrent` 时，agent 引发的投递保持 queued(reason=`seats`)；成员报告 idle / waiting_human 时空出席位并按序投递。用户消息不受席位限制 |
| 合并窗口 | `batch_window_ms` 已可配置并持久保存，尚未执行：FileInbox 没有唤醒动作可合并（agent 经 MCP 自行读取）；原生回合是真实的唤醒动作，但目前每份投递一个回合，按序串行。把窗口内多条合成一个回合（逐条保留标记与凭据）是下一步 |

## 8. 同步、CRUD 与内容

Portage 保存自己的房间、私聊、配置和投递记录。原生会话记录保留 provider、nativeSessionId、nativeEventId、原生时间、采集时间和 cursor。统一时间线保留每条记录的来源。

回显与回读通过原生 ID 或注入关联 ID 去重。原生记录默认进入同步视图，明确的输出转发规则才生成新消息。重连按 cursor 补读，原生日志截断或无法读取时保存可见缺口。推断关联标为 inferred。

| 操作 | Portage 行为 | 原生效果 |
| --- | --- | --- |
| 新建 / 恢复 session | 保存意图和本地身份 | createSession / resumeSession 能力执行并返回真实 ID |
| 搜索 / 读取 | 按权限查持久历史 | readHistory / subscribe 能力同步 |
| 重命名 / 归档 | 修改本地元数据 | 支持时同步原生对象 |
| 编辑消息 | 保存新 revision 与修订关系 | 原生 edit 能力执行，或明确发送更正消息 |
| 删除记录 | 展示本地隐藏、可恢复删除、清理的范围 | 原生删除单独执行并记录结果 |
| 删除 session | 移除关联、归档 | 终止进程、删除原生历史分别显示范围 |

已投递的 Delivery 固定引用实际消息 revision。原生操作部分成功时分别显示结果。

Message.parts 支持 text、markdown、image、audio、video、json、artifact_ref 和 typed 扩展。Artifact 保存 hash、MIME、大小、来源、版本和访问归属。大内容流式进入对象存储，消息保存稳定引用。

本地路径作为来源信息。跨设备通过 artifact ID 下载并材料化为目标可读文件。文本 CLI 可以接收文件引用，原生附件入口可接收二进制内容，转换结果随 Delivery 保存。

同一 session 参加多个房间时，各次注入附带 room / thread。原生宿主仍管理该 session 的上下文。需要独立上下文时创建独立原生 session，再分别加入房间。

## 9. 持久性与故障恢复

| 情况 | 处理 |
| --- | --- |
| 接收后崩溃 | Message、Delivery、Event、Outbox 同事务提交，提交后返回 accepted |
| 客户端重试 | 按 workspace、认证身份、幂等键去重，正文冲突明确返回 |
| 群消息部分失败 | 持久记录目标快照，每个接收方独立成功、等待或失败 |
| 成员变化 | 查询与 dispatch 时检查当前权限，已有历史按读取范围处理 |
| 多消费者并发 | Delivery 租约、native session 输入锁、fencing epoch |
| 原生提交后 ACK 丢失 | 标记 uncertain，回读或原生幂等核对，证明可安全重试后再投递 |
| daemon 重启 | 恢复持久队列，验证 binding，恢复事件和原生读取游标 |
| 配置并发发布 | expectedRevision，记录接收时和实际 dispatch 时的规则版本 |
| 端点时钟不同 | conversation 使用服务端递增 seq，同时保存 native 时间 |
| 记录清理 | 作用范围与 tombstone 可追溯，附件按引用与保留期回收 |

跨进程网络与原生输入之间存在提交不确定边界。投递策略依据适配器提供的幂等、查询和确认能力选择，UI 展示实际证明层级。

## 10. 性能

热路径完成身份 / 策略检查、目标解析和一次短事务。全文索引、图谱聚合、文件预览和长历史补读在后台。SQLite 使用 WAL、单写入调度和复合索引。

队列由新消息、ready、重连和预算恢复事件唤醒，定时器处理到期和重试。每个接收方有界队列，跨房间公平调度。批量投递保留消息 ID 和确认范围。

原生记录增量读取。UI 按 seq 订阅、分页和虚拟列表，断线续传。图谱返回聚合节点与选定 trace，动画帧只更新已有粒子位置，页面隐藏时停绘。

参考机器为 8 个逻辑核心、16 GB RAM、NVMe。以下为工程目标，实测见表后。

| 指标 | 初始目标 |
| --- | --- |
| 规模 | 50 session、10 房间、10 万条历史 |
| 稳态输入 | 20 条 2 KiB 消息 / 秒，每条最长 10 个接收方 |
| 短突发 | 200 条 / 秒持续 10 秒，检查背压与恢复 |
| 持久接收 | p95 小于 50 ms，附件上传、排队与模型耗时单独统计 |
| 事件到 UI | p95 小于 200 ms |
| 已索引分页查询 | 100 条，p95 小于 100 ms |
| daemon 内存 | 目标小于 300 MB，原生 agent 与 UI 分别测量 |
| 图谱 | 100 可见节点、300 边，目标 30 fps 以上，可降低粒子与帧率 |
| 稳定性 | 8 小时断连、积压、恢复和配置变更模拟 |

另测慢接收方公平性、fan-out、文件传输、日志截断、提交后失联及重启。报告硬件、载荷、接收方数量、持久化设置、p50 / p95 / p99 和错误率。

**实测（2026-11-18）**：Apple M5 · 10 逻辑核心 · 24 GB · macOS 26.3 · Node 24；SQLite WAL + synchronous=FULL；50 session、10 房间、10 万条历史（3 万份投递），每条 2 KiB × 10 接收方。复现：`NODE_OPTIONS=--expose-gc npx tsx scripts/bench.ts 100000`。

| 指标 | 实测 | 目标 |
| --- | --- | --- |
| 持久接收（Bus 内 accept + 落盘） | p50 0.9 · p95 3.4 · p99 4.5 ms | p95 < 50 ms |
| 持久接收（HTTP 往返） | p50 2.4 · p95 5.5 · p99 10.6 ms | — |
| 短突发 2000 条 | 255 ms，约 7.9k 条/秒 | 跟上 200 条/秒 |
| 事件 → SSE 客户端 | p50 0.5 · p95 0.8 · p99 2.9 ms | — |
| 事件 → 浏览器画面（含 90 ms 合并刷新） | 约 110 ms | p95 < 200 ms |
| 房间最近 100 条 | p95 < 0.1 ms | p95 < 100 ms |
| UI 起始快照 | 1.9 MB · 10 ms（HTTP 3.7 MB · 37 ms），只随窗口与在途投递增长，不随历史增长；更早的历史与编译正文按需取 | — |
| 重启加载 | 707 ms | — |
| daemon 堆（加载后 GC） | 197 MB（消息 39 MB、投递 8 MB、编译上下文 40 MB） | < 300 MB |
| 画布 | 有运动时约 30 fps（统筹派发线流动、在途信封）；静止房间 0 次绘制，空闲脚本 < 1 ms/s；页面隐藏或 reduced-motion 时停绘 | ≥ 30 fps |

UI 的环境动效（光影、云、呼吸点）只动 transform / opacity 并独立成层。无 GPU 的 headless Chrome 无法验证合成器卸载（每个动画都按帧触发样式计算），需在真实浏览器里用性能面板确认。

最高层 MD 每次加入 query 会增加上下文体积。记录编译字节数及宿主提供的 token 数据，允许预览实际输入。超过配置上限时展示原因，由用户缩减文档或调整上限。模型耗时与通信耗时分别测量。

## 11. 从个人版到团队

个人版与团队版共用应用服务边界，部署链路如下。

```text
个人版：同一台设备

[用户 UI / Agent MCP] ↔ [本地 Portage daemon] ↔ [本地 Adapter] ↔ [原生 Sessions]
                                │
                                └──→ [SQLite / 持久队列 / Artifact 文件存储]


团队版：服务端 + 多台设备

[员工 Web / Desktop UI] ───────────────┐
[企业群聊 / Thread] ↔ [Chat Gateway] ──┼──↔ [Portage 服务端]
[常驻 bot / 服务身份] ────────────────┘          │
                                                ├──→ [认证 / 工作区 / 成员权限]
                                                ├──→ [房间 / 消息 / 持久队列 / 事件]
                                                ├──→ [Artifact 存储 / 审计 / Projections]
                                                │
                                                ├──↔ [设备 A Connector] ↔ [Adapters] ↔ [Sessions A]
                                                ├──↔ [设备 B Connector] ↔ [Adapters] ↔ [Sessions B]
                                                └──↔ [常驻执行节点 Connector] ↔ [原生 Sessions]

[设备原生回复 / 提交凭据 / 同步游标]
        └──→ [Connector] → [服务端记录与路由] → [UI / Chat Gateway] → [对应会话 / 原群聊 Thread]
```

Connector 从设备发起可恢复出站连接，双向箭头表示连接内的任务下发与结果回传。应用消息、权限和房间语义保留在服务端，原生输入在对应设备执行。

| 部署位置 | 承担的工作 |
| --- | --- |
| Portage 服务端 | 工作区、认证、成员权限、房间、消息、持久队列、事件、产物和查询 |
| 员工设备 Connector | 登记设备与本地 Session，保持可恢复连接，执行原生输入与增量回读 |
| 常驻 bot 或服务 | 以授权身份接入通信 API，收发消息与产物 |
| 企业聊天 Gateway | 映射外部群聊、线程、成员和消息 ID，将结果返回对应线程 |

服务端根据稳定 Session ID 将工作交给所属设备。Connector 在设备上核对原生身份后执行投递，并把凭据、输出和同步游标回传。设备离线时，服务端保存待投递工作及等待原因，重连后继续校验和恢复。

个人版使用一个默认工作区、本地拥有者身份、本地数据库和连接器。首版 schema 保留 workspace、owner、device、origin。

团队模式增加身份认证、成员权限、设备登记、远程传输、附件访问、配额与审计。发送方由认证连接派生。设备连接器建立可恢复出站连接，在设备上操作原生 session。

企业聊天 gateway 映射外部 channel、thread、message ID，处理 webhook 去重、成员身份及回复原线程。UI 与外部聊天入口共享 conversation。存储与独立 broker 根据实际规模替换，房间和权限语义保持在应用服务层。

## 12. API 与能力

| API 组 | 典型操作 |
| --- | --- |
| Sessions | list、get、create、resume、rename、archive、setCommunicationEnabled、openNative |
| Conversations | createRoom、addMember、removeMember、setRole、createThread、subscribe |
| Messages | send、reply、forward、list、revise、deleteLocal、getDelivery |
| Policy | getDocument、saveDraft、validate、publish、getEffective、getApplied |
| Control | wakeOnce、pauseRoom、resumeRoom、cancelDelivery、retrySafe |
| Artifacts | upload、get、materialize、listVersions |
| Observability | subscribeEvents、getTrace、getSyncStatus、getMetrics |

适配器按具体连接声明 discover、createSession、resumeSession、readHistory、subscribeNativeEvents、submitInput、nativeAttachments、idleSignal、interrupt、renameNative、editNativeMessage、deleteNativeHistory、reloadNativeConfig 等能力，附支持版本、证据、限制和当前可用状态。

## 13. 实现顺序

1. 迁移 v0.2 类型和应用 API，构建 Registry、Conversation、Policy、Messaging、SQLite 与持久队列。
2. 接通一个真实 CLI，验证指定原生身份、输入、回读、去重和重连。
3. 接通第二种来源，完成用户 → 统筹 → 成员 → 产物 → 汇总的房间闭环。
4. UI 与 MCP 共用 API，验证规则发布、开关、唤醒、预算和信息流。
5. 逐项验证 App / IDE 管理与同步能力，实测性能。
6. 验证多设备、多用户和一个企业聊天 gateway。

对象与状态详见 DOMAIN.md，交互详见 UX.md，真实接入验收详见 MVP.md。

## 14. 参考

Keepane 的 pane actor、ready 边界和投递事件是本地接入参考，Portage 使用独立持久 conversation 与 Delivery。[Keepane](https://github.com/newdee/keepane)、[收件箱设计](https://github.com/newdee/keepane/blob/master/docs/design/mailbox.md)

AgentChatBus 的 thread、seq 游标与房间设置用于参考同步和配置。[AgentChatBus](https://github.com/Killea/AgentChatBus)

Agent Relay 提供通信循环检测与频道批量投递的实现参考。[Loop guard](https://github.com/AgentWorkforce/relay/blob/main/crates/relay-node/src/relay/delivery/loop_guard.rs)、[频道投递](https://github.com/AgentWorkforce/relay/blob/main/crates/relay-node/src/relay/delivery/channel.rs)

用户指定腾讯 Marvis 的房间体验，参考固定工位、工作 / 休眠状态和可见产物。Ego-lite 用于页面实际操作与检查。[腾讯官方介绍](https://marvis.qq.com/news/marvis-free-token)、[Agent 系统说明](https://marvis.qq.com/docs/agent-system)
