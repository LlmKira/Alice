# ADR-234: Wave 5 Shell Session 勘误 — 协议错误、重复基础设施、双重执行

**Status**: ✅ Implemented
**Date**: 2026-04-01
**Type**: 🔧 勘误 + 📐 架构修正
**Supersedes**: ADR-233 §Wave 5（有状态 Shell Session 部分）
**References**:
- [ADR-233](./233-native-toolcall-bt-hybrid.md) — TC-BT 混合执行层（本 ADR 修正其 Wave 5）
- [ADR-207](./207-gvisor-first-container-runner.md) — gVisor-First Container Runner（Wave 3 已实现 persistent session）
- [ADR-201](./201-ai-native-os.md) — OS for LLM（shell-native 执行层）
- OpenClaw `src/agents/sandbox/docker.ts` — 容器执行参考实现（184k★）

---

## 实施记录

### 2026-04-01 执行记录

**执行人**: Claude Code

**Scope**: 
- 删除 `shell-session-v2.ts`（-451 行）— JSON-RPC over bash 协议不匹配
- 删除 `shell-session.ts`（-291 行）— 同样问题的 V1 实现  
- 删除 `session-lifecycle.ts`（-123 行）— 重复基础设施
- 重写 `tc-loop.ts` — 调用 `executeShellScript` → `docker.ts`
- 简化 `callLLM.ts` — 移除 session 管理，直接传 `contextVars`
- 简化 `tick.ts` — 移除双重执行，`callLLM` 返回完整结果直接更新 Blackboard
- 更新 `bridge.ts` — 移除 `episodeId/container` 参数
- 更新测试 — 反映 ADR-233 新语义

**净改动**: -887 行（删除 1088，新增 201）

**验证**:
- `pnpm run typecheck` ✅ 全绿
- `pnpm run test` ✅ 2494/2494 通过
- `pnpm run lint:check` ✅ 通过（原有警告未新增）

---

## 一、问题：ADR-233 Wave 5 实现包含三个结构性错误

对 ADR-233 Wave 5（有状态 Shell Session）的集成代码进行实地审计，发现三个互相关联的结构性错误。这些不是配置问题（如上一轮分析聚焦的 container 硬编码），而是**架构层面的错误**。

### 错误 1：协议不匹配 — JSON-RPC 发给 raw bash（致命）

**涉及文件**：`shell-session-v2.ts`（L275-278）+ `shell-session.ts`（L172-173）

V1 和 V2 的 `sendCommand()` 都向 bash stdin 写入 JSON-RPC 格式：

```typescript
// shell-session-v2.ts:275-278
private sendCommand(cmd: SessionV2Command): void {
  const payload = `__SESSION_START__${JSON.stringify(cmd)}__SESSION_END__\n`;
  this.process!.stdin!.write(payload);
}
```

但接收端是 `docker exec -i container /bin/bash --norc --noprofile`（L83-90）——一个 raw bash 进程。

**Bash 收到的输入**：
```
__SESSION_START__{"id":"ep-42-1","command":"\nweather tokyo\n__ALICE_EXIT=$?\necho \"__CWD__$(pwd)__CWD_END__\"\n...","timeout":30000}__SESSION_END__
```

**Bash 的行为**：尝试执行 `__SESSION_START__{...}__SESSION_END__` 作为 shell 命令 → `command not found`。JSON payload 永远不会被解析，`wrapCommand()` 生成的命令永远不会被执行。

**同时**，`handleOutput()` 期望从 stdout 解析 `__SESSION_START__...__SESSION_END__` 包裹的 JSON 结果——但 bash 输出的是错误信息，不是 JSON。`pendingCommands` 的 Promise 永远不会 resolve（只能超时 reject）。

**根因**：混合了两个互不兼容的协议：
- 方案 X：直接写 raw commands 到 bash stdin，用 marker strings 解析输出（可行，但没实现）
- 方案 Y：写 JSON-RPC，由容器内协议处理器（如 nanoclaw 的 TypeScript agent-runner）解析执行（可行，但容器内没有处理器）

当前代码：用 Y 的发送格式 + X 的 marker 解析逻辑 + raw bash 做接收端。三者互不兼容。

### 错误 2：双重执行 — TC 循环执行 + tick.ts 再执行（设计）

**涉及文件**：`tc-loop.ts`（L112）+ `callLLM.ts`（L134）+ `tick.ts`（L149）

TC 循环内，每个 `run` tool call 通过 `session.execute(command)` 执行命令：

```typescript
// tc-loop.ts:112
const result = await session.execute(command, 30);
```

执行结果聚合后，`callTickLLM` 返回聚合 stdout 作为 `script`：

```typescript
// callLLM.ts:134-138
return {
  script: tcResult.commandOutput || "(no commands executed)",
  afterward: tcResult.afterward ?? "done",
  residue: undefined,
};
```

然后 tick.ts 对这个 "script"（已执行的输出）**再次调用 executeScript**：

```typescript
// tick.ts:149
const scriptResult = await deps.executeScript(stepResult.script, {
  dispatcher: ctx.dispatcher,
  graph: ctx.G,
  contextVars: board.contextVars as Record<string, unknown>,
});
```

`executeScript` 调用链：`executeShellScript` → `executeInContainer` → `executeAliceSandboxProcess` → `docker.ts executeDockerProcess`。它期望的输入是 Alice CLI 命令（如 `weather tokyo`），但收到的是已执行的输出（如 `$ weather tokyo\n22°C, cloudy`）。

**后果**：双重执行。命令在 TC 循环内被执行一次，然后它们的输出被当作新命令再执行一次。由于错误 1（ShellSessionV2 不工作），当前实际上两次都没有正确执行——但一旦修复 TC 循环的执行路径，双重执行会立即暴露。

**根因**：pre-TC 架构中 `callLLM` 返回 LLM 生成的脚本文本（未执行），tick.ts 负责执行。TC 架构下命令在 TC 循环内执行，但 tick.ts 的 `executeScript` 调用没有移除。

### 错误 3：重复基础设施 — ShellSessionV2 ∥ docker.ts（架构）

**涉及文件**：`shell-session-v2.ts`（全文 451 行）vs `skills/backends/docker.ts`（全文 431 行）

**ADR-207 Wave 3 已经实现了完整的 persistent session container 基础设施**（`docker.ts`）：

| 能力 | docker.ts (ADR-207) | ShellSessionV2 (ADR-233 Wave 5) |
|------|---------------------|-------------------------------|
| 容器命名 | `alice-sbx-{hash12}` config hash 驱动 | 无命名，假定 `alice-skill-runner` 已存在 |
| 容器创建 | `docker create --name ... sleep infinity` | 不创建，直接 `docker exec` |
| 容器启动 | `docker start` + 状态检查 | 不管理 |
| 命令执行 | `docker exec -w CWD -e ENV ... sh -c CMD` per call | 持久 bash stdin pipe（协议不通） |
| Config 匹配 | SHA-256 signature → 配置变了自动重建 | 无 |
| Stale 检测 | `No such container` → auto recreate | 无 |
| 并发控制 | `sessionLocks` Map 防并发创建 | 无 |
| 隔离 Profile | sandboxed / hardened / compat + gVisor fallback | 无 |
| runsc 降级 | `shouldFallbackToHardened()` 自动降级 | 无 |
| 清理 | 手动 `docker rm` | `gracefulClose()` kill 进程 |

ShellSessionV2 **从零重写了容器执行**，但质量远低于已有的 `docker.ts`，且协议不通。

**根因**：实现者不知道 `docker.ts` 已经有 persistent session container（ADR-207 Wave 3 ✅），从 nanoclaw 参考文档直接实现了一个独立的 session 管理器。

---

## 二、OpenClaw 参考（实地读源码，非二手摘要）

OpenClaw（184k★）的容器执行架构验证了 `docker.ts` 的模式是正确的。

### 执行模型

```
容器创建：docker create ... CONTAINER_NAME sleep infinity → docker start
命令执行：docker exec -i [-t] -w WORKDIR -e KEY=val CONTAINER_NAME sh -lc "COMMAND"
```

- **每条命令 = 一次 `docker exec`**，不维护持久 bash 进程
- **容器文件系统自然保持状态**（pip install、mkdir、写文件）
- **无 marker 协议**：stdout/stderr 直接捕获
- **Login shell** (`sh -lc`)：sources `/etc/profile`

### Config Hash 匹配

```typescript
// OpenClaw: sandbox/docker.ts
// 每次执行前检查容器配置是否一致
const inspected = await inspectContainer(containerName);
if (inspected.configHash !== expectedHash) {
  await destroyAndRecreate(containerName, config);
}
```

与 Alice `docker.ts` 的 `ensureDockerSession` → `inspectDockerSession` → signature 比对完全同构。

### Session 命名与 Scope

```
session scope → container name: openclaw-sbx-session-{slug}
agent scope → container name: openclaw-sbx-agent-{slug}
shared scope → container name: openclaw-sbx-shared
```

对应 Alice `docker.ts`：`alice-sbx-{hash12}`（基于配置内容 hash 命名）。

### 自动清理

```typescript
// OpenClaw: sandbox/prune.ts
// 5 分钟扫描一次，闲置 24h / 存活 7d 自动删除
if (idleMs > 24 * 60 * 60 * 1000 || ageMs > 7 * 24 * 60 * 60 * 1000) {
  await execDocker(["rm", "-f", entry.containerName]);
}
```

Alice `docker.ts` 目前没有自动清理——这是一个合理的后续改进项（F5），但不阻塞 Wave 5 修正。

---

## 三、正确架构

### 核心原则

> **TC 循环应复用 shell-executor.ts → docker.ts 管线，不应另建并行执行路径。**

ADR-207 Wave 3 的 `docker.ts` 已经解决了容器生命周期管理。ADR-233 Wave 5 只需要在 TC 循环中调用现有基础设施，而不是重写一套。

### 执行流（修正后）

```
TC 循环：LLM → tool_use run({command: "weather tokyo"})
  ↓
executeShellScript("weather tokyo", { contextVars })    ← 复用现有管线
  ↓
executeInContainer("weather tokyo", env)
  ↓
docker.ts executeDockerProcess(opts)
  ├─ ensureDockerSession(opts) → alice-sbx-{hash12}
  ├─ docker exec -w /home/alice -e ... alice-sbx-{hash} sh -c "weather tokyo"
  └─ return { stdout, stderr, code }
  ↓
ScriptExecutionResult { logs, errors, thinks, completedActions, ... }
  ↓
TC 循环：tool_result → 追加到 messages → 回 LLM
```

**与 pre-TC 路径的区别**：
- pre-TC：`callLLM` 返回脚本文本 → `tick.ts` 调用 `executeScript` → 结果回 board
- post-TC：`callLLM` 内部 TC 循环已执行 → `callLLM` 返回聚合结果 → `tick.ts` **不再调用 `executeScript`**

### cwd/env 持久化（当前不需要，预留设计）

Alice 当前命令空间（`irc`/`self`/`weather`/`music`）全是无状态 API 调用，**不需要 cwd/env 持久化**。

当未来引入有状态命令（code interpreter、file ops）时，在 TC 循环层面追踪状态：

```typescript
interface TCShellState {
  cwd: string;
  env: Record<string, string>;
}

// 每次 docker exec 后，从命令输出提取新 cwd
// 下次 docker exec 通过 -w 和 -e 注入
```

这与 OpenClaw 的模式一致：状态在宿主侧追踪，每次 `docker exec` 注入。

---

## 四、ADR-233 Wave 5 Spec 修正

### 原 Spec（ADR-233 §Wave 5）

推荐方案 B（session file + source），并列了方案 A（常驻 shell 进程）。

### 修正后 Spec

**取消方案 A / B / C 的选型。** Wave 5 不需要新的 session 机制——直接复用 ADR-207 的 `docker.ts` persistent session container。

| 原 Spec | 修正 |
|---------|------|
| 方案 A：容器内常驻 shell 进程 | ❌ 删除。协议复杂且 `docker.ts` 已覆盖 |
| 方案 B：容器内 session 文件 | ❌ 删除。`docker exec` per call + 外部状态追踪更简洁 |
| 方案 C：宿主 shell（不隔离） | ❌ 删除。违反 ADR-207 隔离策略 |
| **新方案：复用 docker.ts + TC 循环状态追踪** | ✅ 正解 |

### 修正后任务表

原 Wave 5 任务：

| 原 ID | 原内容 | 新状态 |
|-------|--------|--------|
| F15 | ShellSession 维护 cwd/env | **删除** — TC 循环层面追踪（需要时再加） |
| F16 | 状态持久化 source/捕获 | **删除** — docker.ts 已有 session container |
| F17 | TOOL_SUBAGENT | **保留**（不受影响） |
| F18 | Subagent 执行器 | **保留**（不受影响） |
| F19 | Session 跨 episode | **保留**（不受影响） |

新增修正任务：

| ID | 问题 | 修复 | 文件 |
|----|------|------|------|
| **R1** | TC 循环使用 ShellSessionV2 执行（协议不通） | 改为调用 `executeShellScript` | `tc-loop.ts` |
| **R2** | callLLM 返回聚合 stdout 作为 `script`，tick.ts 双重执行 | callLLM 返回 `ScriptExecutionResult`，tick.ts 跳过 `executeScript` | `callLLM.ts`, `tick.ts`, `types.ts` |
| **R3** | ShellSessionV2 + SessionV2Manager 全文死代码 | 删除 `shell-session-v2.ts` | `shell-session-v2.ts` |
| **R4** | ShellSession V1 + SessionManager 全文死代码 | 删除 `shell-session.ts` | `shell-session.ts` |
| **R5** | callLLM.ts 中的 acquireSession + releaseTickSession 死代码 | 删除，简化 callTickLLM 签名 | `callLLM.ts` |
| **R6** | tick.ts 硬编码 container + episodeId 构造 | 删除 Wave 5 参数传递（不再需要） | `tick.ts` |
| **R7** | TCLoopContext 类型不含 sessionId/container/cwd/env | 清理类型，只保留 LLM 调用需要的字段 | `tc-loop.ts`, `callLLM.ts` |

---

## 五、实施 Waves

### Wave R1: TC 循环执行路径修正（blockedBy: 无）

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| R1 | TC 循环使用 executeShellScript | `tc-loop.ts` | `session.execute(command)` → `executeShellScript(command, { contextVars })` |
| R2 | callLLM 返回结构化结果 | `callLLM.ts`, `types.ts` | 返回 `ScriptExecutionResult`（含 logs/errors/thinks/completedActions），不再返回 `script` 文本 |
| R2b | tick.ts 跳过 executeScript | `tick.ts` | TC 路径下直接使用 callLLM 返回的结构化结果 |
| R7 | TCLoopContext 类型清理 | `tc-loop.ts` | 去掉 sessionId/container/cwd/env，增加 contextVars |

**预期改动量**：~150 行净改动

**验证**：
- [ ] `pnpm run typecheck` 通过
- [ ] `pnpm run test` 通过
- [ ] `pnpm run lint` 通过
- [ ] TC 循环实际执行 Alice CLI 命令并返回结果（手动验证或新增测试）

### Wave R2: 死代码清理（blockedBy: R1-R7）

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| R3 | 删除 ShellSessionV2 | `shell-session-v2.ts` | 整文件删除（451 行） |
| R4 | 删除 ShellSession V1 | `shell-session.ts` | 整文件删除（291 行） |
| R5 | 清理 callLLM.ts | `callLLM.ts` | 删除 acquireSession/releaseTickSession/sessionV2Manager import |
| R6 | 清理 tick.ts | `tick.ts` | 删除 episodeId/container 构造和传递 |

**预期改动量**：-700 行净删除

**验证**：
- [ ] `pnpm run check` 全绿
- [ ] 无 import 引用残留

### Wave R3: 后续改进（可选，不阻塞验收）`#可选`

| ID | 改动 | 文件 | 内容 |
|----|------|------|------|
| R8 | docker.ts 自动清理 | `docker.ts` | 闲置容器定期清理（参考 OpenClaw prune.ts，idle 24h / age 7d） |
| R9 | cwd/env TC 循环追踪 | `tc-loop.ts` | 引入有状态命令时，在 TC 循环层面追踪 cwd/env，通过 docker exec -w/-e 注入 |

---

## 六、教训

### 为什么会写出坏的 ShellSessionV2

1. **不知道 docker.ts 已经有 session container**（ADR-207 Wave 3）。如果知道，直接调用 `executeDockerProcess` 即可。
2. **Cargo-cult nanoclaw 的协议**。nanoclaw 的 JSON-RPC 协议设计给 TypeScript agent-runner（一个理解 JSON-RPC 的进程），不是给 raw bash。
3. **没有端到端验证**。协议不匹配意味着 ShellSessionV2 从未成功执行过一条命令。

### 可复用的审查检查清单

在为 Alice 添加新的执行路径时，先检查：

- [ ] `docker.ts` 是否已经有对应能力？（persistent session、docker exec、隔离 profile）
- [ ] `shell-executor.ts` 的管线是否可复用？（preprocessScript、sanitize、thinks extraction）
- [ ] 是否存在双重执行？（TC 循环内执行 + tick.ts 再执行）
- [ ] 协议两端是否匹配？（发送格式 ↔ 接收端解析能力）
- [ ] timeout 单位是否一致？（秒 vs 毫秒）

---

## 七、附录

### A. 超时单位混淆（次要 bug）

`tc-loop.ts:112`：
```typescript
const result = await session.execute(command, 30); // 30 是秒还是毫秒？
```

`shell-session-v2.ts:214-244` 中 `doExecute` 把 timeout 当作毫秒：
```typescript
const cmd: SessionV2Command = {
  timeout: timeout || 30000,  // 传入 30 → cmd.timeout = 30
};
const timeoutMs = cmd.timeout; // 30ms！
setTimeout(() => { reject(...); }, timeoutMs); // 30ms 后超时
```

若 30 是秒意图，实际 30ms 超时——每条命令都会 timeout。

### B. TCLoopContext 类型 vs 实际使用

`tc-loop.ts` 定义：
```typescript
export interface TCLoopContext {
  openai: OpenAI;
  model: string;
  providerName: string;
  systemPrompt: string;
  userMessage: string;
  // 无 sessionId、container、cwd、env
}
```

`callLLM.ts` 创建：
```typescript
const tcCtx: TCLoopContext = {
  openai: client.openai,
  model: client.model,
  providerName: client.name,
  systemPrompt: system,
  userMessage: user,
  sessionId: episodeId,   // 不在类型中，TypeScript 不报错但语义误导
  container,              // 同上
  cwd,                    // 同上
  env,                    // 同上
};
```

TypeScript 对象字面量赋值允许多余属性（因为 `tcCtx` 是 `TCLoopContext` 类型变量），但 `tc-loop.ts` 永远不会访问这些多余字段。
