# Portage

统一管理原生 agent 会话，支持跨来源对话、房间协作、消息与产物传递，以及可追踪的信息流。

用户从 Codex / Claude 等来源的 App、VS Code CLI、Terminal session 出发，直接对话或组成房间。Portage 管理通信、范围、分层规则、投递与记录，原生宿主负责模型调用和执行。

## 当前状态

本次版本包含 v0.2 架构与产品设计文档、UX 规范和 HTML 交互原型。原型使用模拟数据，真实服务端、适配器和持久存储待实现。

| 文件 | 内容 |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品场景、分工边界、默认选择和讨论重点 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 名词、箭头链路图、配置、性能和团队部署 |
| [docs/DOMAIN.md](docs/DOMAIN.md) | 对象、状态、凭据与存储 |
| [docs/UX.md](docs/UX.md) | 来源树、房间、对话、信息流与规则 |
| [docs/MVP.md](docs/MVP.md) | 真实接入与故障恢复验收 |
| [demos/portage-ux-demo.html](demos/portage-ux-demo.html) | 本地交互原型 |

## 查看原型

用浏览器直接打开 [demos/portage-ux-demo.html](demos/portage-ux-demo.html)。样式与交互脚本已内嵌在 HTML 中，无需安装依赖。也可以在项目根目录启动静态服务后访问 /demos/portage-ux-demo.html。

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

原型包含模拟会话、房间、角色规则、消息与信息流。真实原生能力按适配器逐项验证。
