# Portage v1.0 测试计划

原则：能力质量第一；架构清晰干净；逻辑链路合理；不重复造轮子；通用优化修复；信息注入与能力挂载合理；不影响现有合理能力与链路；无冗余残留缺失。

验收不是「断言绿了就行」，而是深读实现与真实链路，确认：

1. **是否按设计做了且合理**
2. **按了设计是否正确使用**
3. **用了以后结果、质量与链路是否符合预期且质量高**

目标是达到设计预期，不是完美无缺。有大局观；遇问题找根因；不为小改动反复空转全量。

## 层级（小 → 大）

| 层 | 范围 | 通过标准 |
| --- | --- | --- |
| L1 模块 | types、policy 解析、inbox 排序、幂等键、epoch 校验 | 单模块行为与 DOMAIN 一致；边界与错误原因可解释 |
| L2 单链路 | 用户→Bus→Message/Delivery→Scheduler→Adapter→回读 | 状态机完整；凭据层级正确；不丢不重 |
| L3 模块联动 | Registry×Conversations×Policy×Messaging×Delivery | 开关、退出房间、预算、MD revision 与投递互相约束正确 |
| L4 端到端 | 两 CLI + 三成员房间；统筹/Swarm；信息流可观测 | MVP.md 场景可人工复现；UI 与事件一致 |

## 必测情况（摘）

- 加入 / 退出房间；退出后自动 Delivery held，历史按策略
- 统筹唯一；Swarm 无派发连线；模式切换不改写历史
- 无工种角色；MD 仅约束指导，不覆盖原生身份
- Inbox 排队：busy→queued，预算→held，就绪按序提交
- `rounds/max_auto_rounds`；达上限停自动唤醒
- 通信关闭、房间暂停、只读入口降级
- 幂等、崩溃恢复、uncertain 回读、部分成员离线
- 前端：来源树、房间、对话、信息流三栏与检查器联动

## 当前未验证项（如实记录）

- **真实 Codex / Claude Code 作为 MCP client 读到投递**：协议与行为已用官方 SDK client 经真实 stdio 验证，但尚未由真实 CLI 进程端到端跑过。需要在对应 CLI 里加入 `npm run mcp:config` 输出的配置，涉及用户账号与个人配置，需用户确认后再做。
- **Claude 真实来源**：本机未安装 Claude CLI，房间里的 Claude 成员为演示身份。
- **PTY 直接注入**：未实现；当前依赖 MCP 读取。
- 开发期依赖（`vitest`/`vite` 的传递依赖）存在已知漏洞告警，修复需跨大版本升级，不进入运行时；运行时依赖 `npm audit --omit=dev` 为 0。

## 执行节奏

先 L1 随实现补齐 → 每条核心链路 L2 深测 → 联动 L3 → MVP L4。  
失败时先定位根因（设计偏差 / 使用错误 / 实现缺陷），再通用修复，再回归相关链路。

## 当前自动化覆盖（随实现更新）

| 包 | 覆盖 |
| --- | --- |
| `@portage/core` | wake / delivery / acceptMessage / ContextCompiler（含执行策略、产物引用层）/ MemoryBus：统筹→@成员、轮次与每分钟预算 held 及放宽释放、暂停恢复与通信重开后冲刷、退出后保持 held、幂等冲突、EventLog 因果链、修订、私聊、预览与真实投递同层、产物；SqliteSnapshot：快照/事件/产物持久化，重启续 seq 与幂等 |
| `@portage/adapters` | FileInbox（Bus 注入正文 + 约束层）/ process discovery 接线 |
| `@portage/daemon` | HTTP L4：双 provider 三成员、收件箱文件与上下文快照逐字一致、回执 adapter/凭据、busy→ready、pause/resume、disable/enable、预览、产物、私聊、登记/加入/退出、Swarm 不唤醒、幂等冲突、SSE 推送、重启续号 |
| `@portage/mcp` | 真实 MCP client → stdio → 真实 portage-mcp 进程（从无关 cwd 经 launcher 启动）→ 真实 Daemon：工具清单与描述、`portage_room` 视角、完整闭环（用户→统筹读取并 ack→@成员排队 busy→成员报 idle→读取→同 trace 回复，因果链逐条指向上游）、submitted≠已读、读取不改忙闲、坏别名/未知回复/超长输入的可操作报错、退出房间后不可发送、祖先 pid 解析会话与归档后的引导、Daemon 不可达提示、`--print-config` |
| `@portage/adapters`（补充） | `ancestorPids` 对真实进程树（含子进程回溯到测试进程） |
| `@portage/web` | 浏览器实测：房间/对话/信息流三视图、演示协作真实投递、粒子画布采样、工位接收与发言气泡、消息链路凭据与实际 query、发现与登记、私聊视图、Swarm 无连线；刷新不重播动画 |

运行：`npm test` · `npm run typecheck` · `npm run daemon:serve` · `npm run dev:web` · `npm run daemon:demo`
