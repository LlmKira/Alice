# ADR-107 Engagement Session — 审查发现

> 审查范围：ADR-105/106/107/108 实现 + Result Contract 重构
> 日期：2026-02-18

## 审查结论

**结构性重构通过。** 原始三缺陷全部消除，引入了 Result Contract 类型安全层。

## 已修复的结构性缺陷

### D1. 状态爆炸 → EngagementSession 类

**原状**：engagement 循环维护 10 个 `eng*` 变量 + 子周期 11 个 `acc*` 变量，在 3 个分支中手动同步。

**修复**：`EngagementSession` 类（`engagement.ts:36-93`）封装所有跨子周期状态。一个 `absorb(sub)` 替代 8 个 push + 2 个标量合并。`pendingActions()` / `markAllExecuted()` 追踪执行状态。

### D2. 修正轮次 dead code + 重复 → runCorrectionRound

**原状**：wait_reply 和 terminal 分支各 ~50 行修正代码。terminal 版本额外 push 到 `subMerged`，但 `subMerged` 在 `break` 后出作用域——三行死代码。

**修复**：`runCorrectionRound()`（`result.ts:165-227`）提取为单一函数。修正结果直接写入 `EngagementSession`，dead code 消除。

### D3. formatQueryObservations God Switch → CQRS Formatter 共置

**原状**：12-case switch × `as any` × 三文件协同。

**修复**：`resultContract<T>()`（`action-defs.ts`）将 Zod schema 作为 single source of truth：
- **写端**：`store(G, nodeId, data)` — 编译期类型安全
- **读端**：`formatResult(raw)` — 运行时 `safeParse`
- **共置**：schema + attrKey + source + formatter 定义在同一个 contract 对象

`formatQueryObservations`（`prompt.ts:464-498`）从 158 行 switch → 30 行通用循环。

### D4. stay_here 过时消息 → 语义修正

**原状**：stay_here 累积 commands（含 reply），在安全网 flush 时可能发送过时消息。

**修复**：engagement 循环三分支统一使用 THINK → LISTEN → SPEAK → BRANCH 线性流（`loop.ts:341-456`），所有 outcome 共享执行路径。

## 附带修复

- **DB 迁移缺失**：生成 `0010_nice_mikhail_rasputin.sql`，补全 `engagement_subcycles` / `engagement_duration_ms` / `engagement_outcome` 三列
- **import type lint**：`result.ts` import 语句修正
- **格式化 + import 排序**：`loop.ts`, `engagement-session.test.ts` 自动修复

## 验证

| 指标 | 结果 |
|------|------|
| typecheck | 0 errors |
| lint | 0 errors, 20 warnings (pre-existing) |
| test | 75 files, 1450 tests passed |

## 关键文件变更

| 文件 | 变化 |
|------|------|
| `engine/act/engagement.ts` | +94 行（EngagementSession + SubcycleResult） |
| `engine/act/result.ts` | +62 行（runCorrectionRound + 辅助函数） |
| `engine/act/loop.ts` | 重写 engagement 循环（-400 → +200 行） |
| `engine/act/prompt.ts` | formatQueryObservations 重写（-158 → +30 行） |
| `telegram/action-defs.ts` | +12 Zod schemas + resultContract + 12 contracts |
| `engine/act/index.ts` | 新增 exports |
| `drizzle/0010_*.sql` | engagement 列迁移 |

## 更进一步：改进方向分析

> 按影响 × 可行性排序。每项给出问题根因、预期收益、实施路径。

### I-1. Engagement 期间抢占估算不完整（高影响 · 中难度）

**问题**：`quickPressureEstimate()` 仅投影 P5（回应义务），忽略 P2-P4/P6。
engagement 持续 60-180s 期间，若发生 P2 记忆过期尖峰、P6 好奇心突变，当前机制无法检测。

**根因**：完整 evolve tick 成本 O(n)，engagement 内联执行会阻塞消息发送。

**方案**：在 `prepareEngagementWatch` 内注册第三个 watcher——"pressure drift watcher"。
每隔 POLL_INTERVAL（3s）做一次 **mini-perceive**：仅对新到达事件更新图属性，
重新计算 targetChannel 的 P1+P5 两维（成本 O(1)），若 drift > threshold 则触发 interrupt。

这比完整 evolve 便宜两个数量级，但覆盖了最常见的抢占场景（新消息引起的 P1/P5 跳变）。

**预期收益**：消除 engagement 期间"盲窗"，论文 Lemma 2 的 bounded deviation 约束从 worst-case 180s 收紧到 ~3s 粒度。

### I-2. 跨聊天时间记忆桥接（高影响 · 中难度）— **部分实施**

**问题**：Alice 刚在私聊和 Bob 讨论完一个话题，30 秒后在群聊看到 Bob 发言——
但群聊的 buildPrompt 不包含私聊上下文。Alice 表现为"失忆"。

**根因**：`fetchRecentMessages()` 按单 chat 拉取。Mod contribute() 有 memory 和 diary，
但它们是长期记忆（分钟~小时级），不覆盖"刚刚发生"的跨聊天关联。

**方案演进**：

| 阶段 | 状态 | 实现 |
|------|------|------|
| Phase 1 | ✅ 已实施 | `timeline.ts:234-271` 跨聊天观察标记 — 检测 `recent_chat`/`messages from` 文本模式，用 `--- cross-chat reference ---` 包裹注入 |
| Phase 2 | ⚠️ 未实施 | `recent-cross-chat.mod` — 主动查询 action_log 最近 5 分钟内 Alice 在其他聊天的行动摘要 |

**当前实现** (`timeline.ts`):
```typescript
function isCrossChatObservation(obs: string, target: string): boolean {
  if (!obs.includes("recent_chat") && !obs.includes("recentChat") && !obs.includes("messages from"))
    return false;
  if (obs.includes(target)) return false;  // 当前聊天不算跨聊天
  return true;
}
```

**限制**: Phase 1 依赖 observation 文本模式匹配，是被动检测而非主动查询。

**预期收益**：解决用户最容易感知到的"割裂感"。真人自然会带着私聊印象参与群聊——Alice 也应该如此。

**下一步**: 若 Phase 1 覆盖不足，实施 Phase 2 的主动查询机制。

### I-3. 自适应 Gold Example 选择（中影响 · 低难度）

**问题**：gold-examples.ts 用 binary 条件（isGroup、hasBots、hasStickers）选择示例。
群聊中技术讨论 vs 闲聊 vs 争论需要截然不同的行为模式，但当前注入相同的示例集。

**根因**：gold example 选择没有 "情境相似度" 的概念。

**方案**：为每个 gold example 打标签（`tags: ["technical", "emotional", "casual", ...]`），
在 `buildScriptGuide()` 中用当前上下文（open threads 类型、mood、最近消息情绪）做简单 tag 匹配，
优先注入匹配度高的示例。不需要 embedding，纯 tag 匹配 + priority 排序。

**预期收益**：LLM 在技术讨论中看到"先查询再回答"的示例，在情感对话中看到"先倾听再回应"的示例。行为契合度提升。

### I-4. Engagement 会话级审计日志（中影响 · 低难度）

**问题**：当前 action_log 记录单次行动（tick 级），无法追溯一个完整 engagement session 的决策链。
调试"Alice 为什么在群聊里突然沉默"需要逐 tick 拼凑。

**方案**：新表 `engagement_log`，每个 session 一行：

```
engagement_id | tick | target | subcycles | duration_ms | outcome |
entry_pressure | exit_pressure | actions_summary | preempted_by
```

`EngagementSession.toAuditRecord()` 在 processResult 前生成，一次 INSERT。

**预期收益**：调试成本从"拼凑 action_log"降到"一条 SQL 查 engagement_log"。这是 engagement 可观测性的基础设施。

### I-5. V-Maximizer 公平性修正（中影响 · 高难度）

**问题**：V-maximizer 纯贪心 argmax——如果 Contact A 始终有更高的 V，Contact B 永远不被选中，
即使 B 的 P3（关系冷却）持续增长。Attention Debt（ADR-100）部分缓解，但仅作用于 V 加分，
不改变 argmax 结构。

**根因**：单轮 argmax 无法表达"轮流陪"的语义。

**方案（两阶段）**：

Phase 1（低成本）：在 V 计算中加入 `fairness_bonus = α · ticks_since_last_selected`。
这是 attention debt 的扩展，直接影响 V 值排序而非仅作为 tie-breaker。

Phase 2（中成本）：V-maximizer 输出 Top-2 候选。如果 V_1 - V_2 < δ（如 0.3），
两个目标都入队 ActionQueue（优先级分先后），让 ACT 循环在一个 tick 内服务两个聊天。
这需要 ActionQueue 支持 batch enqueue + priority。

**预期收益**：解决"重要但不紧急的朋友被长期忽略"的问题。论文的 Structural Homeostasis 定理目前仅保证所有频道最终被访问，但对"多久"没有上界——fairness bonus 提供了这个上界。

### I-6. 全局心情状态机（低影响 · 中难度）

**问题**：当前 mood 是 per-node 属性（ALICE_SELF.mood_valence），仅由 LLM 的 `feel()` 指令写入。
没有"今天心情不好所以所有聊天都更安静"的全局调制。

**根因**：mood 和 personality 是解耦的——personality 影响声部竞争，mood 仅影响 System 1。

**方案**：在 evolve tick 中加入 `mood_modulator`：读取 ALICE_SELF.mood_effective，
当 mood < -0.3 时全局 API floor 乘以 1.5（更难触发行动），
当 mood > 0.5 时 API floor 乘以 0.7（更容易触发行动）。
类似 circadian multiplier 的机制，但由情绪驱动而非时间驱动。

**预期收益**：产生"今天 Alice 特别健谈"或"Alice 今天有点安静"的宏观行为模式——
目前缺失的"日级情绪节律"。但标注为低影响，因为用户可能不会注意到这种细微差异。

---

## 改进优先级矩阵

| 编号 | 改进 | 影响 | 难度 | 建议阶段 |
|------|------|------|------|----------|
| I-1 | 抢占估算完整化 | 高 | 中 | ADR-109 |
| I-2 | 跨聊天时间记忆桥接 | 高 | 中 | ADR-110 |
| I-3 | 自适应 Gold Example | 中 | 低 | 可直接实施 |
| I-4 | Engagement 审计日志 | 中 | 低 | 可直接实施 |
| I-5 | V-Maximizer 公平性 | 中 | 高 | ADR-111 |
| I-6 | 全局心情调制 | 低 | 中 | 待 I-1~I-4 完成后 |
