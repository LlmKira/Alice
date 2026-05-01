# QQ OneBot 接入

本手册只讲运行部署；架构理由见 ADR-264 / ADR-265。

## 支持范围

Alice 的第一条 QQ 路线是 **OneBot v11 + NapCatQQ**。这里的 QQ 是终端 IM 平台，OneBot / NapCat 只是协议和桥接实现，不进入 Alice 的平台命名空间。

当前已支持：

- 群聊文本发送：`channel:qq:<群号>`
- 私聊文本发送：`contact:qq:<QQ号>`
- reply 发送：`message:qq:<聊天 native id>:<消息 native id>`
- OneBot 反向 WebSocket 入站消息
- 群聊 / 私聊消息写入 canonical event
- 私聊、@Alice、reply-to-Alice 的 directed 判断
- 图片、语音、视频、文件、表情等常见消息段的文本占位投影

当前不承诺：

- QQ reaction / read receipt 与 Telegram 等价
- 富媒体发送和文件拉取的端到端闭环
- 群成员同步、群管理事件、撤回事件完整投影
- QQ 官方 Bot API 路线
- Satori 路线

## 推荐部署形态

推荐把 QQ 协议端和 Alice runtime 分成两个进程：

```text
NapCatQQ
  -> OneBot v11 HTTP action API
  -> OneBot v11 WebSocket events
  -> Alice runtime
```

原因很简单：QQ 登录、QQNT 版本、session、风控和协议波动应该留在 NapCat 侧；Alice 只依赖 OneBot 的 action/event 契约。

## Alice 配置

编辑 `runtime/config.toml`：

```toml
[qq]
onebot_api_base_url = "http://127.0.0.1:3000"
onebot_event_ws_url = "ws://127.0.0.1:3001"
onebot_access_token_env = "ONEBOT_ACCESS_TOKEN"
onebot_timeout_ms = 10000
onebot_reconnect_min_ms = 1000
onebot_reconnect_max_ms = 60000
```

如果 OneBot 端没有启用 access token，可以把 `onebot_access_token_env` 留空：

```toml
onebot_access_token_env = ""
```

如果启用了 access token，在 `.env` 中写：

```bash
ONEBOT_ACCESS_TOKEN=change-me
```

配置含义：

| 字段 | 含义 |
|------|------|
| `onebot_api_base_url` | OneBot HTTP action API 地址；空字符串表示禁用 QQ 出站发送 |
| `onebot_event_ws_url` | OneBot 事件 WebSocket 地址；空字符串表示禁用 QQ 入站 |
| `onebot_access_token_env` | `.env` 中保存 access token 的变量名 |
| `onebot_timeout_ms` | HTTP action 超时 |
| `onebot_reconnect_min_ms` | 入站 WebSocket 重连退避下限 |
| `onebot_reconnect_max_ms` | 入站 WebSocket 重连退避上限 |

## NapCat 配置要点

NapCat 侧只需要保证两件事：

1. 开启 OneBot v11 HTTP action API，地址与 `onebot_api_base_url` 一致。
2. 开启 OneBot v11 事件 WebSocket，地址与 `onebot_event_ws_url` 一致。

如果 NapCat 配了 token，Alice 的 `ONEBOT_ACCESS_TOKEN` 必须一致。Alice 发 HTTP action 时使用 `Authorization: Bearer <token>`；连接事件 WebSocket 时会把 token 放进 `access_token` query 参数。

## 稳定 ID 规则

Alice 内部只使用 QQ 平台名，不使用 OneBot / NapCat 作为平台名：

| 场景 | ID |
|------|----|
| QQ 群目标 | `channel:qq:123456789` |
| QQ 私聊目标 | `contact:qq:10001` |
| QQ 消息引用 | `message:qq:123456789:456` |

不要写成 `channel:onebot:*`、`channel:napcat:*` 或 `channel:satori:*`。这些都是桥接路径，不是聊天平台。

## 启动与重启

配置改完后重启 Alice runtime：

```bash
pm2 restart alice-runtime
pm2 list
```

如果不是 pm2 部署，就用当前部署方式重启 runtime。关键要求只有一个：Alice 启动时能读取新的 `runtime/config.toml` 和 `.env`。

启动后看日志，应该能看到 OneBot 事件接收器启动和连接成功：

```text
OneBot event receiver started
OneBot event WebSocket connected
```

如果只配置了 `onebot_api_base_url`，没有配置 `onebot_event_ws_url`，那只启用 QQ 出站发送，不会连接事件 WebSocket。

## 最小验证

先验证出站文本：

```bash
ALICE_ENGINE_URL=http://127.0.0.1:<engine-port> \
  irc say --in channel:qq:123456789 --text "QQ transport smoke test"
```

私聊目标使用：

```bash
ALICE_ENGINE_URL=http://127.0.0.1:<engine-port> \
  irc say --in contact:qq:10001 --text "QQ private smoke test"
```

reply 使用 stable message id：

```bash
ALICE_ENGINE_URL=http://127.0.0.1:<engine-port> \
  irc reply --in channel:qq:123456789 \
  --ref message:qq:123456789:456 \
  --text "收到"
```

`<engine-port>` 取 Alice runtime 日志中的 Engine API 监听端口，或使用运行环境已经注入的 `ALICE_ENGINE_URL`。

再验证入站：

1. 用 QQ 群里其他账号发普通消息，确认 Alice 日志没有 OneBot ingest 错误。
2. @Alice 发一条消息，确认该消息进入 directed 路径。
3. 回复 Alice 刚发出的 QQ 消息，确认 reply-to-Alice 能被识别。

## 常见问题

### `unsupported_capability`

说明当前目标平台没有对应能力，或 QQ adapter 没启用。先检查 `onebot_api_base_url` 是否非空，Alice 是否已重启。

### `onebot_action_failed`

说明 OneBot HTTP action API 返回失败。重点看返回里的 `action`、`status`、`retcode`、`responseText`，再去 NapCat 日志定位。

### WebSocket 一直重连

检查：

- `onebot_event_ws_url` 是否是事件 WebSocket 地址，不是 HTTP action 地址
- NapCat 事件端是否已经启动
- access token 是否一致
- 端口是否只监听在容器内部

### QQ 收不到消息

按顺序排查：

1. Alice 是否真的调用了 `send_group_msg` 或 `send_private_msg`
2. NapCat 是否返回了非 0 `retcode`
3. QQ 账号是否在目标群里，或是否能私聊目标用户
4. 目标 ID 是否写成了 QQ 群号 / QQ 号，而不是 OneBot 连接名

## References

- [ADR-264: QQ Platform Support via OneBot Bridge](../../docs/adr/264-qq-platform-support/README.md)
- [ADR-265: Multi-IM Platform Support Strategy](../../docs/adr/265-multi-im-platform-strategy/README.md)
- `@see docs/reference/AstrBot/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py`
- `@see docs/reference/LangBot/src/langbot/pkg/platform/sources/aiocqhttp.py`
- `@see docs/reference/LangBot/src/langbot/pkg/platform/sources/aiocqhttp.yaml`
