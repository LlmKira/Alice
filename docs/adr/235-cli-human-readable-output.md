# ADR-235: CLI 人类可读输出规范 — 从 JSON 透传到自然语言

**Status**: In Progress  
**Date**: 2026-04-01  
**Type**: 📐 架构规范 + 🎨 用户体验  
**References**:
- [ADR-201](./201-ai-native-os.md) — OS for LLM: shell-native 架构
- [ADR-233](./233-native-toolcall-bt-hybrid.md) — TC-BT 混合执行层
- [ADR-236](./236-cli-output-structural-fix.md) — 结构性修复（erratum）
- `docs/adr/55-prompt-style-research/` — Prompt 风格研究

---

## 问题：Alice 在读 JSON，不是自然语言

### 现状

当前 CLI 工具（`irc`, `self`, `engine`）内部调用 Engine API，API 返回 JSON，CLI **直接透传**给 stdout：

```bash
$ irc whois @cleanery
{"ok":true,"result":{"chatId":"channel:476520042","display_name":"cleanery",...}}

$ self feel valence=positive
null
{"ok":true,"result":{"affect":"feel","valence":"positive",...}}
null
```

### 为什么这是错的

1. **角色扮演破裂**：Alice 是一个 "住在 Telegram 的女孩"，她看到的应该是人类可读的描述，不是机器 JSON
2. **浪费 Token**：JSON 语法（`{"ok":true,"result":...}`）占据大量 prompt 空间
3. **认知负担**：LLM 需要从 JSON 解析语义，而不是直接读取
4. **与论文矛盾**：Shell Mind 理论（ADR-201 基础）假设 Alice 像人类一样使用 shell，人类不读 JSON

### 对比：正确的 CLI 输出

```bash
# 当前（错误）
$ irc whois @cleanery
{"ok":true,"result":{"display_name":"cleanery",...}}

# 应该（正确）
$ irc whois @cleanery
Channel: cleanery
Members: 42 active in last 24h
Last message: 2 min ago
Your role: member

# 当前（错误）
$ self feel valence=positive
null
{"ok":true,"result":{...}}

# 应该（正确）
$ self feel valence=positive
✓ Recorded: feeling positive
```

---

## 决策

### 核心原则

> **CLI 是 Alice 的感官，不是调试接口。**
> 
> CLI 输出必须是自然语言、人类可读、角色扮演一致。

### 分层责任

```
┌─────────────────────────────────────────┐
│  Alice (LLM)                            │
│  ─────────────────────                   │
│  看到: "✓ Sent message to Bob"          │
│  不是: '{"ok":true,"result":...}'        │
└─────────────────────────────────────────┘
                   ↑
                   │ stdout 人类可读渲染
┌─────────────────────────────────────────┐
│  CLI 工具 (irc/self/engine)             │
│  ─────────────────────────               │
│  接收: Engine API JSON 响应              │
│  渲染: 自然语言输出                      │
│  原则: 像 Unix CLI 一样工作             │
│         ls 显示文件名，不是 inode 号    │
└─────────────────────────────────────────┘
                   ↑
                   │ HTTP / Unix Socket
┌─────────────────────────────────────────┐
│  Engine API                             │
│  ───────────                            │
│  格式: JSON (机器协议，不变)             │
│  用途: 程序化访问、测试、调试            │
└─────────────────────────────────────────┘
```

### 渲染规范

#### 1. 成功响应模板

```bash
# 简单确认
✓ <动作>: <对象>
✓ Sent message to Bob
✓ Recorded: feeling positive
✓ Joined channel: tech-discuss

# 带数据返回
<标题>: <值>
<标题>: <值>
---
Channel: tech-discuss
Topic: "Weekly sync Fridays 10am"
Members: 42 (12 active in last hour)
Your role: admin
Last activity: 3 min ago

# 列表
1. <name> — <description>
2. <name> — <description>

$ irc tail 3
1. Bob: "下次聚会什么时候？"
2. Alice: "周末吧，周六晚上？"
3. Carol: "好呀，我都可以"
```

#### 2. 错误响应模板

```bash
# 用户级错误（不堆栈）
✗ <问题>
✗ Cannot send: Bob has blocked you
✗ Invalid target: @unknown-user

# 系统级错误（简洁）
✗ Failed: <reason>
✗ Failed: network timeout
```

#### 3. 空/默认响应

```bash
# 空结果
(no messages)
(no active threads)

# 默认值
(no output)
```

### 字段映射规则

| API JSON 字段 | CLI 渲染 | 示例 |
|--------------|---------|------|
| `ok: true` | `✓` 或省略 | `✓ Message sent` |
| `ok: false` | `✗ <error.message>` | `✗ Rate limited` |
| `result.display_name` | 直接显示 | `cleanery` |
| `result.last_activity_ms` | 相对时间 | `2 min ago` |
| `result.mood_valence` | 语义标签 | `mood: positive` |
| `result.*_count` | 带上下文 | `42 members` |
| 枚举值 | 人类可读 | `role: admin` 不是 `role: 3` |

### 保留 JSON 的场景

以下场景保留 JSON 输出（使用 `--json` flag 显式触发）：

```bash
# 脚本化调用（非 LLM 使用）
$ irc whois @bob --json
{"ok":true,"result":{"display_name":"Bob",...}}

# 测试/调试
$ self feel valence=positive --json
```

默认行为（无 flag）：人类可读格式。

---

## 实施范围

### Wave 1: 核心命令（高优先级）

| 命令 | 当前输出 | 目标输出 |
|------|---------|---------|
| `irc say` | JSON/null | `✓ Sent: <text>` |
| `irc reply` | JSON/null | `✓ Replied to #<id>` |
| `irc react` | JSON/null | `✓ Reacted <emoji>` |
| `irc whois` | JSON blob | 多行人类可读 |
| `irc tail` | JSON array | 编号消息列表 |
| `self feel` | JSON/null | `✓ Recorded: feeling <mood>` |
| `self note` | JSON/null | `✓ Noted: <fact>` |
| `self diary` | JSON/null | `✓ Diary entry added` |

### Wave 2: 查询命令（中优先级）

| 命令 | 当前输出 | 目标输出 |
|------|---------|---------|
| `self recent-chat` | JSON array | 格式化消息流 |
| `self contact-profile` | JSON blob | 多行简介 |
| `self chat-mood` | JSON | 语义描述 |

### Wave 3: App 命令（低优先级）

App CLI（`weather`, `music`, `google`）已有人类可读输出，无需改动。

---

## 实施策略

### 方案 A：CLI 层渲染（推荐）

在 CLI 可执行文件（`opt/alice/bin/irc`, `opt/alice/bin/self`）中添加渲染逻辑：

```typescript
// irc CLI 伪代码
const response = await fetchEngineAPI(...);
if (response.ok) {
  console.log(renderWhois(response.result));
} else {
  console.error(`✗ ${response.error.message}`);
}

function renderWhois(result: WhoisResult): string {
  const parts = [
    `${capitalize(result.chat_type)}: ${result.display_name}`,
    result.topic ? `Topic: "${result.topic}"` : null,
    `Members: ${result.member_count} (${result.active_24h} active in 24h)`,
    `Your role: ${result.alice_role}`,
    `Last activity: ${relativeTime(result.last_activity_ms)}`,
  ];
  return parts.filter(Boolean).join('\n');
}
```

**优点**：
- 单一职责：CLI 负责人类接口，API 负责机器接口
- 向后兼容：API JSON 不变，不影响其他消费者
- 渐进实施：逐个命令迁移

**缺点**：
- CLI 体积增加（但渲染逻辑简单）

### 方案 B：API 层渲染（备选）

Engine API 新增 `Accept: text/plain` 响应格式：

```bash
# 默认 JSON
GET /telegram/whois → {"ok":true,"result":...}

# 人类可读
GET /telegram/whois -H "Accept: text/plain" → Channel: cleanery\nMembers: 42...
```

**缺点**：
- API 承担渲染责任，违反分层
- 需要协商 Accept header

---

## 验证标准

### 检查清单

- [ ] `irc say` 输出 `✓ Sent: ...` 而不是 JSON
- [ ] `self feel` 输出 `✓ Recorded: ...` 而不是 JSON
- [ ] `irc whois` 输出多行可读文本
- [ ] `--json` flag 显式返回机器格式
- [ ] 错误消息人类可读（无堆栈）
- [ ] prompt logs 显示干净的自然语言

### 回归测试

```bash
# 测试人类可读输出
$ irc say "hello" | grep -v '{'
✓ Sent: hello

# 测试 JSON 模式
$ irc say "hello" --json | jq '.ok'
true
```

---

## 相关 ADR

| ADR | 关系 |
|-----|------|
| ADR-201 | 父级：OS for LLM 架构 |
| ADR-233 | 并行：TC 循环执行层 |
| ADR-55 | 参考：Prompt 风格研究 |

---

## 拒绝的替代方案

### ❌ 在 prompt-builder 中过滤 JSON

**问题**：只是隐藏问题，不解决根本（Alice 不应该看到 JSON，而不是 prompt 不显示 JSON）。

### ❌ 修改 API 返回格式

**问题**：破坏程序化消费者（测试、外部脚本）。API 应该保持 JSON。

---

## 下一步

1. 确认方案 A（CLI 层渲染）
2. 制定 Wave 1 实施计划
3. 选择试点命令（建议 `irc whois` → `self feel` → `irc say`）
