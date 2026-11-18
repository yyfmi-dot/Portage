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

## 真实端到端（L4，2026-11-18）

- **真实 Codex 三成员房间**：三个真实 Codex 线程（统筹 / 实现 / 评审）以原生回合登记，用户一条消息 → 统筹派发 → 实现方写出 `wordcount.py` 并自测 → 评审通过 → 统筹汇总，约 70 秒走完。6 份投递全部 `submitted` + `native_confirmed`，agent 经 MCP 回复产生 `agent_ack`，同一 trace 因果链完整。第一次跑出的四个根因均已修复：`exec resume` 退回只读沙箱（改为继承会话策略）；只读 MCP 工具在 approval=never 下被拒（补 `destructiveHint: false`）；统筹在回合内轮询收件箱（回复方式层写明发出即可结束回合）；暂缓缺少原因说明（`Delivery.detail`）。
- **真实 Claude Code**：输入经回读 `native_confirmed`；回合本身因账号组织禁用订阅访问而失败，失败原因如实显示在会话状态上。需要 API key 才能跑完整回合。
- **Linux（node:22 容器，无 lsof）**：CI 同款步骤 `npm ci` → 类型检查 → 全部测试 → Web 构建。首次运行暴露 `attached` 检测依赖 `lsof`、缺失时静默当作空闲（可能与交互中的会话并发回合）；改为 Linux 直接读 `/proc/<pid>/fd` 后 131 项全过。
- **房间舞台遮挡检查**：演示协作全程每 150 ms 量一次发言气泡与「已投递 / 已读」标签是否压住其他工位的名称、显示器、状态，或自己的名称；1440×900 下 0 处。用户气泡位置在 1280 / 1440 / 1920 宽度下逐一量过。
- **浏览器实测（headless Chrome 经 CDP）**：静止房间 0 次画布绘制；统筹房间约 30 fps；API 发送到画面约 110 ms；两页历史加载后阅读位置偏移 ≤ 1 px，到最早一条后按钮消失；改绑 → 「确认新绑定 · 放行 1 条」→ 回到「等待就绪」；原生记录视图的标题、关联标记与同步状态；控制台零错误。

## 当前未验证项（如实记录）

- **向交互中的 PTY / IDE / App 直接注入**：未实现。会话被交互式进程占用时投递 held(`attached`)，释放后再走原生回合。
- **合并窗口**（`batch_window_ms`）：可配置但未执行；原生回合目前每份投递一个回合，见 ARCHITECTURE §7「实现（v1.0）」。
- **环境动效的合成器卸载**：无 GPU 的 headless Chrome 无法区分，需在真实浏览器的性能面板确认。
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
| `@portage/core`（调度与恢复） | 活动席位排队并在成员空闲时投递、用户消息不受席位限制；单链路唤醒上限；限速暂缓带 `nextAttemptAt` 并由 `tick` 在窗口重开后放行；适配器抛错 → uncertain；回读 present → submitted（凭据带原生路径）、absent → 安全重试、unknown → 保持；中断于 dispatching 的投递重启后为 uncertain；自动轮次按 trace 计数 |
| `@portage/core`（策略头） | 文档化 schema 全字段解析、无策略头、未知键/越界/错段一次列出、发布即应用且 query 只含正文、统筹者不在房间时整份拒绝且策略与 revision 不变 |
| `@portage/core`（持久化） | 增量事务写入、EventLog 超过内存上限仍完整落盘、旧版快照迁移 |
| `@portage/adapters`（补充） | macOS/Linux `ps` 进程表与祖先链；`isAgentCli` 排除桌面 App、app-server、MCP 子进程；FileInbox `verify` 的 present / absent |
| `@portage/daemon`（补充） | 策略头经 HTTP 生效、非法策略头 400 且不改变已发布版本、单独调整席位与链路唤醒预算 |
| `@portage/web`（补充） | 浏览器实测：待你处理提醒条与工位、席位与链路唤醒计量、信封粒子与派发流动线、顶部行气泡侧向弹出、推断回应虚线、对话 @ 标签 / 回复引用 / 逐接收方凭据、将唤醒预测、`⌘K` 面板模糊匹配别名、策略头实时校验与禁止发布 |

| `@portage/adapters`（原生回合） | 假 `codex exec resume`（真实记录格式）驱动真实 NativeTurnAdapter：发现（标题、跳过子 agent 与 IDE 注入、markdown 链接标题）、就绪（ready / offline / 被 `tail -f` 占用 / 外部刚写入 vs 自己的回合）、提交参数（cwd、MCP、沙箱继承、无策略不覆盖）、运行中 busy、verify、增量 readNative、失败 / 崩溃 / 静默后中断；Claude 记录方言、`readPolicy`、半行记录 |
| `@portage/core`（原生绑定） | epoch 改绑暂缓 / 确认 / 无变化不改绑 / 游标重置；取消；回读关联 exact / inferred / unknown、回合开始切断关联、去重、只由本会话回读核对 uncertain、读取错误；输入锁与顺序；跨会话并发提交且在途计入席位；回合结束带说明转 idle；`attached` 暂缓附说明、tick 放行；上下文超限丢层 / `context_too_large` 暂缓并在修订或调高上限后放行；回复产生 `agent_ack` |
| `@portage/core`（持久化补充） | 原生记录与游标重启后保留，再读不重复导入 |
| `@portage/daemon`（原生房间） | 真实 runtime + 真实 NativeTurnAdapter + 假 codex：发现并登记、统筹房间完整闭环（6 条消息全部 native_confirmed、回复 ack、轮次计数）、回合失败显示原因且下一条照常提交、改绑 / 取消 / 确认、中断 |
| `@portage/daemon`（有界快照） | 80 条历史只下发最近 50 条（`hasMore` / `fromSeq`）、`beforeSeq` 分页、未知会话与未知投递上下文 404 |
| `@portage/mcp`（补充） | 每个工具都声明 `readOnlyHint` 或 `destructiveHint: false`，headless 回合里不会被审批拒绝 |

运行：`npm test` · `npm run typecheck` · `npm run daemon:serve` · `npm run dev:web` · `npm run daemon:demo`
