# Portage v1.0 实现验收

浏览器原型展示体验。以下场景在真实服务端与适配器实现后验收。

## 核心闭环

- 从两个 CLI 来源登记真实 session，准确显示 provider、harness、host 和原生身份。
- 发送到指定 terminal session，原生记录可核对输入和来源，回读去重。
- 三个成员加入房间；其中一名可退出房间，退出后不再自动唤醒，历史按策略可读。
- 模式切换：统筹时有且仅有一位 coordinator，房间视图显示派发连线；Swarm 时无成员固定连线。
- 无房间工种角色；协作 MD 仅为约束指导，不覆盖原生 session 身份。
- 统筹模式下用户消息先唤醒负责人；负责人通过 MCP/Bus 联系成员并形成完整 trace。
- 收件箱按 Session 排队：busy 时 queued，预算命中 held，就绪后按序提交。
- 自动轮次：界面与策略一致显示 `rounds/max_auto_rounds`（如 2/4）；达上限后自动唤醒停止。
- 全局和房间 MD 每次 query 按版本注入；关闭通信与暂停房间后后续自动投递 held。

## 故障与并发

- 接收提交前后崩溃，accepted 对应 Message、Delivery、Event 可恢复。
- 同请求重复返回同一逻辑结果，正文冲突明确报错。
- 群消息部分离线时其他成员继续接收。
- 原生提交后失联进入 uncertain，回读或原生幂等能力核对。
- 切换会话和重连后旧 epoch 项重新检查。
- 配置发布与发送并发，记录接收与实际 dispatch 的规则版本。

## UI

- 来源树 Provider → App / VS Code CLI / Terminal → Session。
- 加入与退出入口完备；信息流含时间线、Trace 图、投递板。
- 未唤醒、工作中、待用户、排队、预算、关闭、离线、未知有文字区分。

逐项扩展 App / IDE bridge、多设备、多用户和企业聊天 gateway。
