# Portage

统一管理原生 agent 会话：跨来源对话、房间协作、消息与产物传递，以及可追踪的信息流。

Portage 管理通信、范围、分层规则、投递与记录；原生宿主负责模型调用和执行。不要求 agent 实现 ACP/A2A——直接对接已有原生 session。

## 当前状态 · v1.0

| 文件 | 内容 |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品场景与 v1 冻结决策 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 名词、链路、房间模式、收件箱与轮次 |
| [docs/DOMAIN.md](docs/DOMAIN.md) | 对象、状态、凭据与存储 |
| [docs/UX.md](docs/UX.md) | 来源树、加入/退出、模式连线、信息流 |
| [docs/MVP.md](docs/MVP.md) | 真实接入验收 |
| [docs/TESTPLAN.md](docs/TESTPLAN.md) | 模块→链路→联动深测计划 |
| [packages/core](packages/core) | 领域类型、唤醒/投递、ContextCompiler、MemoryBus（EventLog、Artifact）、SQLite 快照 |
| [packages/adapters](packages/adapters) | CLI 进程发现、FileInbox 注入 |
| [packages/daemon](packages/daemon) | 本地 HTTP API + SSE 事件流 |
| [packages/mcp](packages/mcp) | MCP 桥接：让 CLI 里的 agent 读取投递、回复、报告忙闲 |
| [apps/web](apps/web) | 正式 UI：原型设计系统 + Daemon 实时数据 |
| [demos/portage-ux-demo.html](demos/portage-ux-demo.html) | 交互原型（设计基准） |

## 开发

```powershell
# 需要 Node 22+（内置 node:sqlite）
npm install
npm test
npm run typecheck
npm run daemon:serve   # http://127.0.0.1:8787
npm run dev:web        # http://127.0.0.1:5173  (proxy /api → daemon)
npm run daemon:demo
npm run daemon:discover
```

- UI 必须配合 Daemon；未启动时显示等待页并自动重连
- 数据：`~/.portage/portage.db` · 原生收件箱：`~/.portage/inbox/<provider>/<nativeIdentity>/` · 产物：`~/.portage/artifacts/`

## 让 CLI 里的 agent 真正读到消息（MCP）

写入 `~/.portage/inbox` 只证明文本到了原生收件箱（`submitted`）。agent 读取后才产生 `agent_ack`，UI 才显示"已读"。

```powershell
npm run mcp:config     # 打印 Codex / Claude Code 的接入片段（含绝对路径，不会改动你的配置）
```

1. 启动 Daemon，在 UI 里「＋ 登记本机会话」登记该 CLI（原生身份为 `pid-<cli 进程号>`）
2. 把 `mcp:config` 输出的片段加到该 CLI 的 MCP 配置里，重启 CLI
3. 对 agent 说"查看 portage_inbox"

MCP server 是 CLI 的子进程，靠进程祖先链认出自己属于哪个已登记会话，无需手填会话 ID。提供四个工具：

| 工具 | 作用 |
| --- | --- |
| `portage_inbox` | 读取发给自己的消息（含当时生效的约定），读取即记录 `agent_ack` |
| `portage_send` | 发消息给房间/@成员；`replyToMessageId` 让回复沿用同一条 trace |
| `portage_room` | 查看成员与别名、唤醒模式、自己是否统筹者、collaboration.md |
| `portage_status` | 报告 idle / running / waiting_human；idle 时按序冲刷排队消息 |

读收件箱**不会**改变忙闲状态——忙闲是宿主信号，只由 `portage_status` 报告。UI 的"未读"只对至少读取过一次的会话统计，未接入 MCP 的会话只显示"已投递"。

## Daemon API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/snapshot` | 工作区全量投影（会话、房间、消息、投递、凭据、上下文快照、产物、事件） |
| GET | `/api/events/stream?since=` | SSE 推送 Bus 事件，支持 `Last-Event-ID` 续传 |
| GET | `/api/discover` | 扫描本机 Codex / Claude CLI 进程 |
| POST | `/api/sessions` | 登记发现的会话 |
| POST | `/api/sessions/:id` | 重命名 / 归档 |
| POST | `/api/sessions/:id/communication` | 开关信息传递（开启时重新检查暂缓项） |
| POST | `/api/sessions/:id/ready` | 原生就绪，按序冲刷收件箱 |
| POST | `/api/sessions/:id/direct` | 取得与该会话的私聊 |
| POST | `/api/rooms` | 新建房间 |
| POST | `/api/rooms/:id/wake-mode` | 统筹 / Swarm / 仅 @ / 手动 |
| POST | `/api/rooms/:id/pause` | 暂停或恢复自动通信 |
| POST | `/api/rooms/:id/policy` | 发布 collaboration.md 与预算 |
| POST | `/api/rooms/:id/members` · `/members/:participant/leave` | 加入 / 退出 |
| POST | `/api/policy/global` | 发布全局 PORTAGE.md |
| POST | `/api/conversations/:id/send` · `/preview` | 发送；预览接收方实际编译的 query |
| POST | `/api/messages/:id/revise` | 修订消息（排队中的投递使用新版本） |
| POST | `/api/artifacts` | 上传产物 |
| POST | `/api/agent/resolve` | 按祖先 pid 解析会话（MCP 用） |
| GET | `/api/agent/:session/room` | agent 视角的房间、成员、模式 |
| POST | `/api/agent/:session/inbox` | 读取未读投递并记录 `agent_ack` |
| POST | `/api/agent/:session/send` | 以该会话身份发送，服务端推导房间/@/trace |
| POST | `/api/agent/:session/status` | 报告忙闲；idle 冲刷排队消息 |
