# ADR-233: 原生 Tool Use + BT 可变尾部 — 从 CodeAct 到 TC-BT 混合执行层

**Status**: ✅ Implemented (Wave 1-2) / 📐 Superseded by [ADR-234](./234-wave5-session-erratum.md) (Wave 5)
**Date**: 2026-03-31
**Supersedes**: [ADR-232](./232-tc-execution-layer.md) — TC 执行层 Wave 1（episode 续轮是中间态，本 ADR 是终态）
**References**:
- [ADR-213](./213-tool-calling-act-thread.md) — generateObject 取代 ctl stdout（前次 tool calling 评估）
- [ADR-212](./212-nix-agent-single-run-tool.md) — *nix Agent 单 `run` 工具提案（Manus 模式）
- [ADR-231](./231-bt-code-postmortem-dual-zone.md) — bt-code 复盘：累积区 + 可变区双区模型
- [ADR-201](./201-ai-native-os.md) — OS for LLM：shell-native 执行层
- [ADR-169](./169-fire-query-auto-continuation.md) — Fire/Query 自动续轮（跨 tick）
- Manus 帖子 — MorroHsu: "A single `run(command="...")` tool outperforms a catalog of typed function calls"
- `~/.claude/refs/pi-mono/packages/agent/` — pi-mono agent loop 参考实现
- `~/.claude/refs/nanoclaw/` — NanoClaw Anthropic Agent SDK 参考实现

---

## Context

### 三段演化

```
ADR-213: generateObject({script, afterward})
  ↓ 问题：LLM 不能看到中间结果再续调
ADR-232 Wave 1: generateObject + episodeRound（watching 续轮）
  ↓ 问题：仍是 CodeAct 架构，未利用 LLM 训练出的 tool_use 能力
ADR-233: 原生 tool_use（单 run 工具）+ BT 可变系统提示尾部  ← 本 ADR
```

### ADR-213 为什么拒绝 tool calling

ADR-213 评估了 tool calling 并回退到 generateObject，理由是：

1. **多工具目录的认知负荷**：think()、reply()、feel() 各自一个 tool schema → LLM 消耗认知资源选工具而非推进任务
2. **Gemini tool calling 不稳定**：schema 复杂时频繁解析失败
3. **companion agent 不需要 tool_result 回流**：Alice 每轮从 Blackboard 重建 prompt（快照模型）

**但 ADR-213 漏掉了一个关键选项**：不是"多工具目录" vs "generateObject"的二选一，而是 **单 `run` 工具**。

### 为什么现在重新评估

三个新证据：

1. **Manus 的工业验证**（MorroHsu, 2026-03）：2 年 agent 开发后的结论——单 `run(command="...")` 工具 + Unix CLI 胜过所有多工具方案。CLI 是 LLM 训练数据中最密集的 tool-use 模式。

2. **pi-mono / nanoclaw / Claude Code 的共同模式**：
   - pi-mono: `bash(command)` + `read/edit/write` 4 工具，tool_use 自然循环
   - nanoclaw: Anthropic Agent SDK `query()` + MCP 工具，单次 query 内自主链式调用
   - Claude Code: `Bash(command)` + 专用工具，原生 tool_use
   - **共同点**：LLM 在一次会话内自主决定调多少工具、什么顺序，自然累积消息

3. **ADR-231 双区模型的启示**：Alice 已经有累积区（observations）和可变区（Blackboard 快照）。切换到 tool_use 后，消息自然累积 = 累积区，系统提示可变尾部 = 可变区——双区模型天然吻合。

### Alice 的特殊优势：命令空间已就位

Alice 已经有完整的 shell-native 命令空间（ADR-201）：

```
irc tail 5          # 看最近消息
irc say "你好"       # 发消息
irc react ❤️ 123    # 反应
self feel curious   # 内省感受
self remember "..."  # 记忆
self diary "..."    # 日记
weather tokyo       # 天气查询
music search "..."  # 音乐搜索
<cmd> --help        # 渐进发现
```

这些命令在 Docker/gVisor 沙箱中执行（ADR-207），stdout/stderr 自然回流。
**Alice 的命令空间 = Manus 的 `run` 工具的执行对象**。唯一缺的是把 `generateObject({script})` 换成原生 `tool_use: run({command})`。

---

## Decision

将 LLM 调用层从 **instructor-js generateObject** 切换为 **OpenAI 原生 tool_use 协议**，暴露单个 `run` 工具。BT 的世界状态快照通过系统提示可变尾部注入。

### 核心架构

```
┌─────────────────────────────────────────────────────────┐
│  System Prompt                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  静态核心（缓存友好，跨 episode 不变）              │  │
│  │  - Alice 人格 SOUL_CORE                            │  │
│  │  - 命令空间文档（irc/self/engine/app --help）      │  │
│  │  - Gold Examples                                    │  │
│  │  - 行为指南（DM_INSTINCTS / GROUP_INSTINCTS）      │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  可变 BT 尾部（每 episode 由 contribute() 重算）   │  │
│  │  - 压力场快照（mood、P1-P6 语义标签）              │  │
│  │  - 当前目标 + 关系描述                             │  │
│  │  - 世界状态（在线联系人、活跃话题）                 │  │
│  │  - 轮次提示 + observations                          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

Messages（单 episode 内自然累积）:
  [user: 触发事件 + 对话历史]
  → [assistant: tool_use run({command: "irc tail 5"})]
  → [tool_result: "Leo: 你在吗？\nLeo: 今天下雨了"]
  → [assistant: tool_use run({command: "self feel curious\nirc say '在的~下雨了啊，你那边冷吗？'"})]
  → [tool_result: "✓ feel: curious\n✓ sent message"]
  → [assistant: end_turn]  ← LLM 自主停止
```

### 工具定义

单个 `run` 工具：

```typescript
const TOOL_RUN = {
  type: "function" as const,
  function: {
    name: "run",
    description:
      "Execute Alice shell commands. " +
      "Write one command per line. " +
      "Available: irc (Telegram), self (perception), engine (system), app commands. " +
      "Use <command> --help to discover usage.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell script (multi-line ok, one command per line)",
        },
      },
      required: ["command"],
    },
  },
};
```

**为什么单个 `run` 而不是多工具**：
- Alice 的所有能力已经是 CLI 命令，不需要结构化 tool schema
- 单工具消除"选哪个 tool"的认知负荷（ADR-213 的 #1 失败原因）
- CLI 是 LLM 训练数据中最密集的 tool-use 模式（Manus 论点）
- `--help` 渐进发现已就位（ADR-216）

### TC-BT 混合控制流

```
压力场（BT 编排层）— 不变
  ├─ 目标选择（IAUS 评分）
  ├─ 声部竞争（loudness）
  └─ 行动触发
       ↓
Episode 开始
  ├─ 组装 System Prompt（静态核心 + 可变 BT 尾部）
  ├─ 组装 User Message（触发事件 + 对话历史）
  └─ TC 循环（新增）
       │
       ├─ LLM 响应: tool_use → 执行 → tool_result → 追加到 messages → 回 LLM
       ├─ LLM 响应: tool_use → 执行 → tool_result → 追加到 messages → 回 LLM
       ├─ ...（LLM 自主决定调多少工具）
       └─ LLM 响应: end_turn（无 tool_use）→ Episode 结束
            │
            ├─ 从最后一条 assistant message 提取 afterward 信号
            │   （LLM 在 end_turn 文本中用标记表达：[done] / [waiting_reply] / [watching]）
            └─ 结果回流到压力场（更新 Blackboard/Graph）
```

### afterward 信号提取

从 generateObject 的结构化字段切换为 LLM 在 end_turn 文本中的**约定标记**：

```
方案 A: 文本末尾标记
  LLM 在最后一条消息末尾写 [done] / [waiting_reply] / [watching] / [fed_up] / [cooling_down]
  引擎用 regex 提取。默认 [done]。

方案 B: 专用 signal 工具
  增加第二个工具 signal({afterward: "done"})，LLM 在最后一次调用时用它表达信号。
  优点：结构化，无需 regex。缺点：多了一个工具。

方案 C: 合并入 run 工具参数
  run({command: "...", afterward?: "done" | "waiting_reply" | ...})
  LLM 在最后一次 run 调用时附带 afterward。
  优点：单工具不变。缺点：中间调用也有 afterward 参数，可能混淆。
```

**推荐方案 B**：`signal` 工具轻量且结构化，不引入 regex 解析的脆弱性。
只有两个工具（`run` + `signal`），认知负荷极低。

**`watching` 的语义在 TC 下收窄**：
- 旧架构下 `watching` 混合了两层语义：① "等中间结果"（intra-episode，被 TC 消解）+ ② "我还在关注，想继续说/观察展开"（inter-episode 行为状态）
- TC 下 `watching` **只保留 inter-episode 行为语义**：Alice 在关注这个对话，没走开，orchestrator 启动 `prepareStayWatch`（STAY_TIMEOUT=60s 非阻塞 watcher）
- "等中间结果"由 TC 循环内 tool_result 自然回流解决，不再需要 flow 信号
- @see `runtime/src/engine/act/scheduler.ts` — watching slot state + STAY_TIMEOUT
- @see `runtime/src/engine/act/shell-guide.ts:326` — "let it breathe, choose afterward=watching"

```typescript
const TOOL_SIGNAL = {
  type: "function" as const,
  function: {
    name: "signal",
    description:
      "Signal how this conversation should continue after your turn. " +
      "Call this ONCE at the end of your turn. " +
      "done: finished (default if you don't call signal). " +
      "waiting_reply: you said something and expect their response. " +
      "watching: you said something but have more to say, or something is unfolding — " +
      "you want to continue in the next turn. " +
      "fed_up: walk away. cooling_down: take a break.",
    parameters: {
      type: "object",
      properties: {
        afterward: {
          type: "string",
          enum: ["done", "waiting_reply", "watching", "fed_up", "cooling_down"],
        },
      },
      required: ["afterward"],
    },
  },
};
```

### 与 ADR-232 的关系

ADR-232 Wave 1 是**中间过渡态**：在 generateObject 架构上攒轮次。
本 ADR 是**终态**：直接使用原生 tool_use，不再需要 episodeRound 计数器和手动续轮逻辑。

| 维度 | ADR-232（中间态） | ADR-233（终态） |
|------|-------------------|-----------------|
| LLM 调用 | generateObject + episodeRound 续轮 | 原生 tool_use 循环 |
| 续轮控制 | 引擎检查 afterward=watching + 预算 | LLM 自主（end_turn 前自由调 tool） |
| 消息模型 | 每轮从 Blackboard 全量重建 prompt | 静态核心缓存 + 消息自然累积 |
| 工具暴露 | 无（CodeAct 脚本） | `run` + `signal` 两个工具 |
| Token 效率 | 每轮重建 = 重复 system prompt | 静态核心缓存，只追加增量 |

### 缓存经济学

原生 tool_use 的关键优势——**Prompt Caching**：

```
Episode 内第 1 次 LLM 调用:
  [system: 静态核心 (4000 tok) + 可变尾部 (500 tok)]  ← 全量计费
  [user: 触发 (200 tok)]
  = 4700 tok 输入

Episode 内第 2 次 LLM 调用:
  [system: 同上]                                      ← 缓存命中（静态核心不变）
  [user: 同上]
  [assistant: tool_use]                                ← 增量
  [tool_result: 200 tok]                               ← 增量
  = 4700 tok 缓存 + 400 tok 新增

Episode 内第 3 次 LLM 调用:
  = 4700 tok 缓存 + 800 tok 新增
```

对比 generateObject 每轮全量重建（4700 tok × N 轮），tool_use 模式第 2 轮起只付增量。

**关键设计**：静态核心（人格 + 命令文档 + Gold Examples）放 system prompt 开头不变，可变 BT 尾部放 system prompt 末尾。OpenAI/Anthropic 的 prompt caching 从前缀匹配——静态核心越靠前，缓存命中率越高。

### Episode 预算

LLM 自主 tool_use 循环需要预算上限，防止失控：

```typescript
const TC_MAX_TOOL_CALLS = 8;  // 单 episode 最多 8 次 tool_use

// 在 TC 循环中计数
let toolCallCount = 0;
while (true) {
  const response = await llm.chat(messages, { tools: [TOOL_RUN, TOOL_SIGNAL] });

  if (response.stop_reason !== "tool_use") break;  // LLM 自主停止
  if (++toolCallCount >= TC_MAX_TOOL_CALLS) break;  // 预算耗尽

  // 执行 tool_use → 追加 tool_result → 继续
  for (const toolCall of response.tool_calls) {
    const result = await executeToolCall(toolCall);
    messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
  }
}
```

**选择 8 的理由**：
- 典型场景（查天气 → 回复）：2 次 tool_use
- 复杂场景（多源搜索 → 综合 → 回复）：4-5 次
- 极端场景（错误重试 + 多步操作）：6-7 次
- 8 覆盖 >99% 场景，超出记录 `tc_budget_exhausted`

---

## Implementation Waves

### Wave 1: TC 循环核心（blockedBy: 无）

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| F1 | 工具定义 | `llm/tools.ts`（新建） | `TOOL_RUN` + `TOOL_SIGNAL` JSON schema 定义 |
| F2 | TC 循环 | `engine/tick/tc-loop.ts`（新建） | tool_use → execute → tool_result → 回 LLM 循环 |
| F3 | callLLM 替换 | `engine/tick/callLLM.ts` | 从 instructor generateObject → OpenAI chat.completions（tool_use 模式） |
| F4 | tick.ts 简化 | `engine/tick/tick.ts` | 删除 episodeRound/watching 续轮逻辑，TC 循环接管 |
| F5 | System Prompt 分区 | `engine/tick/prompt-builder.ts` | 静态核心（缓存）+ 可变 BT 尾部 分区组装 |
| F6 | afterward 提取 | `engine/tick/tc-loop.ts` | 从 `signal` tool_use 或 end_turn 文本提取 afterward |
| F7 | 测试 | `test/tc-native.test.ts` | 单轮/多轮/预算耗尽/signal 提取 四路径 |

**预期改动量**：
- 新文件：`llm/tools.ts` ~30 行，`engine/tick/tc-loop.ts` ~120 行
- 改文件：`callLLM.ts` ~60 行替换，`tick.ts` ~30 行简化，`prompt-builder.ts` ~40 行
- 测试：~150 行

### Wave 2: Prompt 缓存优化（blockedBy: F1-F7）

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| F8 | 静态/可变分区验证 | `prompt-builder.ts` | 确保静态核心 token 占比稳定，可变尾部 <20% |
| F9 | 缓存命中率监控 | `diagnostics/` | 记录每 episode 的缓存命中率（provider 返回的 cached_tokens） |

### Wave 3: 旧架构清理（blockedBy: F1-F7）

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| F10 | instructor-js 退役 | `llm/instructor-client.ts` | 删除 instructor 依赖 |
| F11 | TickStepSchema 退役 | `llm/schemas.ts` | 删除 generateObject schema（保留 ResidueSchema 如需要） |
| F12 | episodeRound 清理 | 多文件 | 删除 ADR-232 Wave 1 的 episodeRound/tc_budget_exhausted |

### Wave 4: 多模型兼容（blockedBy: F1-F7）`#可选`

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| F13 | Gemini 降级路径 | `llm/tools.ts` | Gemini 不支持 tool_use 时降级回 generateObject |
| F14 | 模型探测 | `llm/instructor-client.ts` | 启动时探测 provider 的 tool_use 支持能力 |

---

## 风险与对策

| 风险 | 可能性 | 对策 |
|------|--------|------|
| LLM 无限调 tool（不 end_turn） | 低 | TC_MAX_TOOL_CALLS 硬上界 |
| 成本上升（多次 API 调用） | 中 | 静态核心缓存抵消 + TC_MAX 保守值 |
| Gemini 等模型 tool_use 不稳定 | 中 | Wave 4 降级路径（generateObject fallback） |
| `signal` 工具 LLM 忘记调用 | 低 | 不调 signal = 默认 done，最安全的默认值 |
| 从 `run` 参数猜测控制流 | 无 | `signal` 工具结构化表达，不需要 regex |
| 迁移期间两种模式并存 | 中 | Wave 1 完成后 Wave 3 立即清理旧代码 |

---

## 预期行为变化

### 天气查询场景

**Before（ADR-232 中间态）**：
```
Round 0: generateObject → script: "weather tokyo" → obs: {"temp":12} → afterward=watching
Round 1: generateObject → script: "irc say '东京12度'" → afterward=done
（2 次 generateObject 调用，每次全量重建 prompt）
```

**After（ADR-233 终态）**：
```
LLM call 1:
  tool_use: run({command: "weather tokyo"})
  tool_result: "Tokyo: 12°C, Sunny"
  tool_use: run({command: "irc say '东京今天晴天 12 度~出门记得防晒'"})
  tool_result: "✓ sent"
  tool_use: signal({afterward: "done"})
  end_turn
（1 次 LLM 会话，2 次 tool_use，静态核心缓存）
```

### 多步社交场景

```
LLM call 1:
  tool_use: run({command: "irc tail 5"})          # 先看看对话
  tool_result: "[Leo: 你在吗？\nLeo: 我有点烦]"
  tool_use: run({command: "self feel concerned"})  # 内省
  tool_result: "✓ feel: concerned"
  tool_use: run({command: "irc say '在的，怎么了？跟我说说？'"})  # 回复
  tool_result: "✓ sent"
  tool_use: signal({afterward: "waiting_reply"})   # 等回复
  end_turn
```

**一次 LLM 会话完成了之前需要 2-3 个 tick 的操作**。

---

## 验收标准

- [ ] `tc-native.test.ts` 四路径全绿（单轮 / 多轮 / 预算耗尽 / signal 提取）
- [ ] 天气场景：`run("weather")` → `run("irc say")` 在 1 个 LLM 会话内完成
- [ ] 压力场调度路径不变（Wave 1 不修改 orchestrator.ts）
- [ ] action_log 可观测 tool_call_count
- [ ] pnpm run check 全绿
- [ ] 静态核心 system prompt 占比 > 70%（缓存友好）

---

## 附录：ADR-213 的重新审视

ADR-213 拒绝 tool calling 的三个理由，在本 ADR 下全部翻转：

| ADR-213 的理由 | 本 ADR 的回应 |
|---------------|-------------|
| ① 多工具目录认知负荷 | 单 `run` 工具 + `signal` 工具，认知负荷 ≈ 0 |
| ② Gemini tool calling 不稳定 | Wave 4 提供 generateObject 降级路径 |
| ③ companion agent 不需要 tool_result 回流 | 错误前提：episode 内消息累积 **就是** 双区模型的累积区，ADR-231 已论证其必要性 |

第三点最关键——ADR-213 当时认为"不需要累积"，但 ADR-231/232 的实践证明：**单 episode 内的中间结果累积是必须的**（空目录 93 轮循环就是缺乏累积的后果）。tool_use 的 messages 自然累积恰好提供了这个能力。

### Flow 信号与 TC 的关系

Flow（afterward）信号和 TC 循环**不冲突，正交互补**：

| 关注点 | 机制 | 谁控制 |
|--------|------|--------|
| Intra-episode：调多少工具、什么顺序 | TC 循环（tool_use → tool_result → 回 LLM） | LLM 自主 |
| Inter-episode：episode 结束后 orchestrator 该做什么 | `signal({afterward})` | LLM 表态一次 |

`watching` 在 TC 下**语义收窄**：不再承担"等中间结果"的 intra-episode 职责（TC 自然解决），只保留 inter-episode 行为状态——"我还在关注这个对话，想继续说或观察展开"。orchestrator 据此启动 `prepareStayWatch`（STAY_TIMEOUT=60s 非阻塞 watcher）。

---

## Wave 5: 有状态 Shell Session + Subagent 架构（未来方向）

### 有状态 Shell Session

**问题**：当前 `executeShellScript` 每次在新容器/进程中执行，无法保持跨 tool call 的状态：

```bash
# Tool call 1
$ export MY_VAR=hello
$ cd /tmp

# Tool call 2（新进程，状态丢失）
$ echo $MY_VAR    # 空
$ pwd             # 回到默认目录
```

**参考：nano claw 的 Session 设计**

nano claw 使用 Anthropic Agent SDK，其 `query()` 支持：
- `resume: sessionId` — 恢复之前的会话
- `cwd` — 工作目录在 session 内保持
- `Bash` 工具在同一个 session 中有状态执行

**Alice 的实现选项**：

| 方案 | 复杂度 | 持久性 | 适用场景 |
|------|--------|--------|----------|
| A: 容器内常驻 shell 进程 | 中 | 跨 episode | 长时间任务 |
| B: 容器内 session 文件 | 低 | 同 episode | 临时变量 |
| C: 宿主 shell（不隔离） | 低 | 跨 episode | 本地开发 |

**推荐方案 B（同 episode 状态）**：

```typescript
// tc-loop.ts 维护 session 状态
interface ShellSession {
  cwd: string;
  env: Record<string, string>;
}

// 每个 episode 开始时创建 session
const session: ShellSession = {
  cwd: "/home/alice",
  env: { ...process.env },
};

// 执行 command 时注入 session 状态
const result = await executeCommand(command, session);
// result 包含新的 cwd/env，更新 session
session.cwd = result.newCwd;
session.env = result.newEnv;
```

**容器内实现**：

```bash
# 使用 script 文件 + source 保持状态
echo 'export MY_VAR=hello' > /tmp/session.sh
echo 'cd /tmp' >> /tmp/session.sh

# 执行命令前 source session
sh -c 'source /tmp/session.sh && echo $MY_VAR && pwd'

# 捕获新的状态
sh -c 'source /tmp/session.sh && env > /tmp/new_env.txt && pwd > /tmp/new_cwd.txt'
```

### Subagent 通过 Tool Use

**洞察**：TC 架构下 subagent 可以是普通 tool。

```typescript
const TOOL_SUBAGENT: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "subagent",
    description: "Delegate a task to a specialized subagent. " +
      "Use for: research, coding, analysis, or any task requiring focused effort.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        context: { type: "string", description: "Additional context" },
        timeout: { type: "number", description: "Timeout in seconds (default: 120)" },
      },
      required: ["task"],
    },
  },
};
```

**执行流程**：

```
LLM: tool_use subagent({task: "分析这组数据"})
  → 启动新容器/进程运行 subagent
  → subagent 使用自己的 tool loop
  → subagent 返回结果
  → tool_result: "分析完成，发现..."
LLM: 基于结果继续主任务
```

**与 BT 的关系**：

- **TC subagent** = 工具层面的委托（intra-episode）
- **BT Parallel** = 目标层面的分叉（inter-episode）

两者正交：可以在 Parallel 分支中调用 subagent tool。

**参考实现**：

- `docs/reference/claw-code/` — Rust 实现的 Claude Code clean-room 重写
- `~/.claude/refs/nanoclaw/` — nano claw 的 Agent SDK 使用模式

> **⚠️ Wave 5 勘误**: [ADR-234](./234-wave5-session-erratum.md) 已修正 Wave 5 实现。原方案（ShellSessionV2 + JSON-RPC）存在协议不匹配、双重执行、重复基础设施三个结构性错误。修正后直接使用 `docker.ts` (ADR-207) 的 persistent session。

### Wave 5 任务

| ID | 改动 | 文件 | 内容 | 状态 |
|----|------|------|------|------|
| F15 | Session 状态 | `tc-loop.ts` | ~~新增 `ShellSession` 维护 cwd/env~~ | ❌ 删除 — ADR-234 |
| F16 | 状态持久化 | `shell-executor.ts` | ~~支持 source/捕获 session 文件~~ | ❌ 删除 — docker.ts 已覆盖 |
| F17 | Subagent 工具 | `llm/tools.ts` | 新增 `TOOL_SUBAGENT` | ⏳ 待实施 |
| F18 | Subagent 执行器 | `subagent-runner.ts` | 容器内运行 subagent，结果回流 | ⏳ 待实施 |
| F19 | Session 跨 episode | `session-persistence.ts` | 可选：序列化 session 到数据库 | ⏳ 待实施 |

