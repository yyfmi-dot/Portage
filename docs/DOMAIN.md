# Portage 领域模型 v1.0

与 ARCHITECTURE.md 共同定义 v1.0 冻结模型；已实现：Session/Participant/Conversation/Membership/RoomPolicy/Message/Delivery/Receipt/PolicyDocument/ContextSnapshot/Artifact/Event/NativeEvent/NativeSyncCheckpoint 及 SQLite 快照持久化；NativeBinding 多入口、Thread、Subscription 待实现（当前一个 Session 绑定一个原生身份与适配器，以 bindingEpoch 记录改绑代次）。

## 身份、来源与连接

| 对象 | 主要字段 | 含义 |
| --- | --- | --- |
| Workspace | id、name、ownerId、policyDocumentId | 个人版默认工作区，团队版授权范围 |
| Principal | id、kind、ownerId、delegation | 由认证或本地可信连接确定的调用者 |
| Session | id、workspaceId、provider、harness、nativeIdentity、displayName、ownerId、communicationEnabled、archivedAt、adapterId?、workdir?、bindingEpoch | 跨重启保持的原生会话身份；adapterId 决定投递方式（原生回合 / 缺省 FileInbox） |
| Participant | id、workspaceId、kind、sessionId?、userId? | 消息与成员关系中的身份 |
| Endpoint | id、deviceId、kind、host、adapterId、capabilities | 当前可连接的入口 |
| NativeBinding | id、sessionId、endpointId、nativeSessionId、epoch、state、activeForDelivery | 原生绑定与活动投递入口 |
| Handle | id、workspaceId、alias、participantId | 可改别名，内部保存稳定 ID |

原生身份按产品命名空间与 nativeSessionId 联合识别。缺少可靠身份时保存发现候选与证据，验证后绑定。分组、重命名与多个入口关联均保留来源。

## 房间与主题

| 对象 | 主要字段 |
| --- | --- |
| Conversation | id、workspaceId、kind direct / room、title、createdBy、policyDocumentId |
| Membership | conversationId、participantId、permissions、historyScope、joinedAt、leftAt?；`leftAt` 非空表示已退出活动成员 |
| RoomPolicy | wake.mode = coordinator \| swarm \| mentions \| manual；coordinatorParticipantId?（统筹模式必填且唯一）；budget 含 max_auto_rounds、rounds 计数 |
| Subscription | conversationId、participantId、threadFilter、readCursor、notificationCursor、wakeMode |
| Thread | id、conversationId、rootMessageId?、title、createdAt、archivedAt? |

Room 与 Team 在 UI 中表达同一通信空间。**不设 RoleAssignment / 房间工种。** 成员保留原生 session 身份；统筹者只是 RoomPolicy 上的路由字段。Thread 组织一个主题的讨论、订阅与引用。collaboration.md 提供约束与指导，不定义模型 persona。

## 消息与内容

```ts
type Message = {
  id: string;
  workspaceId: string;
  conversationId: string;
  threadId?: string;
  seq: number;
  senderId: string;
  target: { kind: "participant" | "room"; id: string };
  mentions: string[];
  parts: ContentPart[];
  replyToMessageId?: string;
  causalParentIds: string[];
  traceId: string;
  source: "user" | "agent" | "gateway";
  idempotencyKey: string;
  acceptedPolicyRevision: string;
  revision: number;
  createdAt: string;
};

type ContentPart =
  | { kind: "text" | "markdown"; text: string }
  | { kind: "json"; value: unknown; schema?: string }
  | { kind: "artifact_ref"; artifactId: string; version: number }
  | { kind: "image" | "audio" | "video"; artifactId: string }
  | { kind: "typed"; contentType: string; artifactId: string };
```

此为契约示意，序列化版本在实现时固定。senderId 从认证上下文派生。修订保留原 Message ID 与递增 revision，Delivery 固定引用实际投递版本。

Artifact 包含 id、workspaceId、hash、MIME、byteSize、originalName、sourceSessionId、sourceMessageId、version、storageKey 和访问归属。大内容流式存储。路径记录来源，跨设备以稳定 ID 访问和材料化。

## 投递与凭据

Delivery 包含 messageId、messageRevision、recipientSessionId、conversationId、targetSnapshot、bindingEpoch、state、reason、attemptCount、nextAttemptAt、lease、dispatchPolicyRevision、compiledContextHash。

新建 Delivery 进入 queued，随后根据投递条件和实际凭据转换状态。

```text
[新建 Delivery] → [queued]
                     ├──暂缓──→ [held] ──条件恢复 + 重新校验──→ [queued]
                     ├──取消──→ [cancelled] ←──取消── [held]
                     │
                     └──租约 + 输入锁──→ [dispatching]
                                              ├──取得凭据──→ [submitted]
                                              ├──明确失败──→ [failed]
                                              ├──未提交且可重试──→ [queued]
                                              └──结果不明──→ [uncertain]
                                                                  ├──回读确认──→ [submitted]
                                                                  ├──证明可安全重试──→ [queued]
                                                                  └──核对后明确失败──→ [failed]
```

重复出现的状态框指向同一状态。submitted 后继续记录 native_confirmed / agent_ack 等凭据，不把模型完成任务与投递成功合并为一个状态。

| 当前状态 | 条件或事件 | 下一状态 | 处理含义 |
| --- | --- | --- | --- |
| queued | 策略或运行条件暂缓 | held | 保存等待原因，保留待投递内容 |
| held | 条件恢复并重新校验通过 | queued | 重新进入可调度队列 |
| queued | 获得租约与原生输入锁 | dispatching | 开始一次原生提交尝试 |
| dispatching | 获得提交凭据 | submitted | 保存证明层级与原生关联 ID |
| dispatching | 提交边界的结果不明 | uncertain | 等待原生查询或回读核对 |
| dispatching | 证明尚未提交且可重试 | queued | 按重试策略重新调度 |
| dispatching | 明确失败 | failed | 保存失败原因和尝试记录 |
| uncertain | 原生回读确认提交 | submitted | 补充对应原生凭据 |
| uncertain | 证明可安全重试 | queued | 重新安排投递尝试 |
| uncertain | 核对后明确失败 | failed | 保存核对结果 |
| queued / held | 收到有效取消请求 | cancelled | 结束这份待投递工作并保留记录 |

DeliveryAttempt 记录每次尝试。DeliveryReceipt 保存 proofLevel written / submitted / native_confirmed / agent_ack、adapterId、bindingEpoch、nativeMessageId、observedAt 和证明摘要。UI 依据实际凭据呈现结果。

## 原生记录与策略

NativeEvent 保存 sessionId、adapterId、nativeEventId、nativeCursor、nativeTime、ingestedAt、parts、correlatedMessageId?、correlation exact / explicit / inferred / unknown。

NativeSyncCheckpoint 保存 sourceGeneration、cursor、lastSuccessAt、gap、error。回显、断线补读按来源去重键处理，缺口可查询。

实现（v1.0）：NativeEvent 为 sessionId、adapterId、nativeEventId（去重键）、nativeTime、ingestedAt、kind（input / output / turn_started / turn_completed / turn_failed）、text、correlatedMessageId?、correlatedDeliveryId?、correlation exact / inferred / unknown。exact 来自输入中的 `[Original message · v… · id]` 标记（旧记录里的 `[原始消息 · v… · id]` 同样识别），并同时产生该投递的 `native_confirmed` 凭据；inferred 为同一回合内、该输入之后的输出；回合开始即切断关联，避免把宿主自己的输入算到上一条消息上。内存中全部会话合计保留最近 2 万条。NativeSyncCheckpoint 为 sessionId、source（记录文件）、cursor（字节偏移）、lastSuccessAt、error；改绑原生身份时清空游标。Delivery 另有 detail?：适配器给出的暂缓说明（如占用该会话的进程），任何下一次状态迁移都会清除。

PolicyDocument 保存 scope、Markdown、已校验结构化 policy、draftRevision、publishedRevision、hash、updatedBy、publishedAt。EffectivePolicy 从各层约束及当前成员权限计算。

ContextSnapshot 保存各文档 revision、接收方、消息版本、编译 hash、字节数和材料化引用。PolicyApplication 保存 publishedRevision、lastInjectedRevision、nativeAppliedRevision? 和 pendingReason。

## 状态维度

| 维度 | 值示例 | 来源 |
| --- | --- | --- |
| Connectivity | connected、reconnecting、offline、unknown | 心跳、连接事件 |
| Execution | idle、running、waiting_human、unknown | 宿主 ready / busy / waiting |
| Attention | dormant、notified、active、throttled | 唤醒和预算 |
| Communication | enabled、disabled | 已授权配置 |
| Inbox | queuedCount、heldCount、oldestAge | 按 Session 持久的 Delivery 有序队列；会排队，busy/预算时 held |
| Sync | current、catching_up、gap、read_only | 同步游标和能力 |

每个状态保存 source、updatedAt 和 freshness，过期信号显示 unknown 或陈旧标识。进度文本保留上报者。

## 事件与存储

Event 保存 workspaceId、conversationId?、seq、eventType、entityId、actorId、traceId?、causalParentIds、serverTime、payloadVersion 和 payload。

事件覆盖 MessageAccepted、DeliveryQueued / Held / Submitted / Uncertain / Failed、NativeEventObserved、PolicyPublished、MembershipChanged、SessionCommunicationChanged、WakeRequested / Suppressed、ArtifactCreated。

Trace 根据显式 causation 建立链路，允许多个上游输入。推断关系单独标注。回复关系同时服务于 thread。

SQLite 包含身份、会话、端点、绑定、房间、成员、订阅、thread、消息和修订、Delivery 和 Attempt、Receipt、原生事件、同步游标、策略和版本、ContextSnapshot、Artifact、Event、Outbox 等表。房间策略中的 coordinatorParticipantId 存在 Conversation/Policy 记录上，不单开工种角色表。

索引覆盖 conversation + seq、session + delivery state + nextAttemptAt、traceId、原生事件去重键、幂等键和 binding epoch。状态与对应事件在同事务中更新。
