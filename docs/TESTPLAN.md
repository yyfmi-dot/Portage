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
- **Linux（node:22 容器，无 lsof）**：CI 同款步骤 `npm ci` → 类型检查 → 全部测试 → Web 构建。首次运行暴露 `attached` 检测依赖 `lsof`、缺失时静默当作空闲（可能与交互中的会话并发回合）；改为 Linux 直接读 `/proc/<pid>/fd` 后 131 项全过。GitHub Actions 首跑（Node 24）又暴露进程发现在 Linux 上用 `ps comm` 当进程名，而 Node 24 把主线程命名为 `MainThread`，导致基于 Node 的 CLI 被漏掉；改为 Linux 取命令行 argv[0] 的可执行文件名，Node 22 / 24 容器各全过。
- **房间舞台遮挡检查**：演示协作全程每 150 ms 量一次发言气泡与「已投递 / 已读」标签是否压住其他工位的名称、显示器、状态，或自己的名称；1440×900 下 0 处。用户气泡位置在 1280 / 1440 / 1920 宽度下逐一量过。
- **浏览器实测（headless Chrome 经 CDP）**：静止房间 0 次画布绘制；API 发送到画面约 110 ms；两页历史加载后阅读位置偏移 ≤ 1 px，到最早一条后按钮消失；改绑 → 「确认新绑定 · 放行 1 条」→ 回到「等待就绪」；原生记录视图的标题、关联标记与同步状态；控制台零错误。

## 真实浏览器验收（2026-11-19，英文界面）

真实 Chromium（ego-browser，带 GPU）里逐项走：

- **帧率**：主线程开销取 `Performance.getMetrics` 前后差，帧间隔用 rAF 采样。静止房间 60 fps（p95 17.4 ms）；演示协作全程约 57 fps；首次打开对话框掉 1 帧，与是否模糊背景无关。环境动效与未读脉冲只动 `transform` / `opacity`。
- **遮挡**：演示协作全程每 150 ms 量一次发言气泡、「Delivered / Read」标签与各工位名称、显示器、状态行，以及气泡之间。760×900、900×800、1024×768、1280×800、1366×768、1440×900、1920×1080 七种尺寸下均为 0 处。交接时旧气泡先退场（`leaveAt`），新气泡等它让出（`startAt`），所以同一时刻不会叠两个。
- **窄屏与长名称**：900 px 以下工具栏换行、舞台按容器尺寸缩放；会话名过长时工位、成员、关系图、消息头、唤醒预览均省略显示并保留完整 `title`。
- **交互**：提示条在顶栏下方，不压输入框；归档会话带 7 秒「Undo」；共享文件按原名合并为最新版本 + 版本数；`⌘K` 无查询时按分组排序、有查询时按相关度；消息与原生记录正文渲染行内代码和链接。
- **命名**：成员名直接取各会话原生标题，Portage 不注入角色或职责；演示里的名字只是种子数据。
- **文件查看器**：十类样例文件逐一打开、逐个标签切换，控制台 0 错误。Markdown 有大纲、KaTeX 公式、Mermaid 图、shiki 高亮代码块（带复制）、任务列表；CSV / TSV / XLSX 表格按列推断数值与日期，可排序、可筛选，带数据条；图表在折线、面积、柱状、散点之间切换，X 与序列可选，量级相差 10 倍以上的序列分面板，分类柱按值排序，附最新 / 最小 / 最大 / 均值 / 变化；JSON 显示树形，有对象数组时出表格与图表；`.mmd` 渲染为图；HTML 在 `sandbox="allow-scripts"` 的 srcdoc 里运行，探针确认读不到父页面、连不上 Daemon；PDF、图片（棋盘底、缩放、原始尺寸）、代码按扩展名高亮。图表区随宽度重绘不抖动（只在宽度变化 ≥ 8 px 时、每帧一次）。渲染库全部按需加载，首屏主 JS 约 93 KB。
- **整体体验审查（2026-11-20）**：逐个视图、对话框、空状态在 1024–1920 宽截图复核后修正：顶栏压缩、活动面板只在 Room 视图显示；工位按人数排布（3 人成三角、5 人不压投放区）；状态行不再重复状态词；收件箱统计一行排开；1024 宽侧栏不再折行；「Add members」全员已在时给出去「Find local sessions」的出口；空房间对话给「Add members」按钮，引导文案按模式区分；私聊视图隐藏演示与模式控件；新建房间直接进 Room 视图；提示条不再挡住「Add member」。门口「You」的气泡按实际遮挡量选左右，四种尺寸下不再压任何成员的名称、显示器或状态。
- **房间改名**：右侧面板「Rename」、双击标题、`⌘K`「Rename room」三处入口；只改名字（`RoomRenamed` 事件记新旧名），成员、历史、规则不变；空名、超过 50 字返回 400，未知房间 404。
- **拖出房间**：工位和右侧成员行都可拖。拖到侧栏即移出房间，拖到另一个房间即移过去；都带「Undo」，撤销时若它原是统筹会把统筹交还。移出只结束成员关系（`leftAt`），会话本身、原生记忆和它在别的房间的成员身份不受影响（daemon 测试覆盖）。
- **Daemon 来源校验**：此前任何网页都能向 `127.0.0.1` 的 Daemon 发 `text/plain` POST 唤醒 agent。现在非本机 `Origin`（含 `null`）与非本机 `Host`（防 DNS 重绑定）一律 403，CORS 只回显本机来源；无 `Origin` 的 MCP / CLI 不受影响。文件内容接口带 `CSP: sandbox`（PDF 除外）与 `nosniff`。

## 真实 Codex 三成员复跑（2026-11-19）

- **只读线程**：9 份投递全部送达，但成员无法写文件。这是会话自身的 `sandbox_policy` 为只读，Portage 按设计继承、不放宽。成员用中文回复来自用户自己的 AGENTS.md，原生身份未被覆盖。
- **可写线程**（各自第一句要求英文）：用户一条消息 → 统筹派发 → 实现方写出 `wordcount.py` → 评审 → 统筹汇总，约 82 秒，7 份投递全部 `submitted`；`echo "hello brave new  world" | python3 wordcount.py` 输出 4。
- **轮次语义修正**：统筹的收尾汇总不唤醒任何人，原先也被计为一轮，计数会超过上限。现在不唤醒任何人的 agent 消息不算一轮（ARCHITECTURE §5.1），界面上的轮次也不再超过上限显示。

## 当前未验证项（如实记录）

- **向交互中的 PTY / IDE / App 直接注入**：未实现。会话被交互式进程占用时投递 held(`attached`)，释放后再走原生回合。
- **合并窗口**（`batch_window_ms`）：可配置但未执行；原生回合目前每份投递一个回合，见 ARCHITECTURE §7「实现（v1.0）」。
- **GPU 进程开销**：GPU 进程由整个浏览器共享，按进程取的 CPU 时间无法单独归到 Portage 页面，只以帧率和主线程开销为准。
- **Claude Code 完整回合**：需要 API key，见上文。
- **真人用户测试**：尚未做。
- **文件查看器范围**：Excel 只读 `.xlsx`（旧 `.xls` 按二进制处理）；不解析 Vega-Lite 等图表规格文件；表格最多显示前 1000 行（筛选与排序作用于全部行）。
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
| `@portage/daemon`（来源与文件内容） | 外站 / `null` Origin 与外部 Host 403 且无 CORS 回显，本机来源放行；产物内容按 MIME 返回（文本带 charset、无类型时按扩展名推断）、`CSP: sandbox`、inline 文件名、未知 id 404 |
| `@portage/mcp`（补充） | 每个工具都声明 `readOnlyHint` 或 `destructiveHint: false`，headless 回合里不会被审批拒绝 |

运行：`npm test` · `npm run typecheck` · `npm run daemon:serve` · `npm run dev:web` · `npm run daemon:demo`
