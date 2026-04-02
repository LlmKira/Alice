# ADR-236: CLI 输出层结构性修复

**Status**: In Progress  
**Date**: 2026-04-01  
**Type**: 🔧 Erratum  
**References**:
- [ADR-235](./235-cli-human-readable-output.md) — CLI 人类可读输出规范
- [ADR-202](./202-engine-api.md) — Engine API

---

## 问题：ADR-235 首次实施暴露三处结构性缺陷

### 缺陷清单

| # | 缺陷 | 严重程度 | 根因 |
|---|------|---------|------|
| D1 | query 端点返回 `{ok, result}` 包装，irc.ts 用 `unwrapQuery` 在消费端 ad-hoc 猜测解包 | 🔴 结构性 | 解包逻辑不在传输层 |
| D2 | `renderKeyValue` 对嵌套对象输出 `[object Object]` | 🔴 结构性 | `String(v)` 不处理 object 类型 |
| D3 | query 命令（motd/threads/whois @target）降级到通用 `renderHuman`，输出质量远低于 write 命令的专用渲染 | 🟡 局部性 | 无专用渲染器 |

### D1 详解：unwrapQuery 是错误的抽象层级

```typescript
// 当前（错误）：消费端 ad-hoc 解包
function unwrapQuery(raw: unknown): unknown {
  if (raw != null && typeof raw === "object" && "result" in raw) {
    return (raw as { result: unknown }).result;
  }
  return raw;
}

// irc.ts 中每个 query 命令都要记得调用
const raw = await enginePost("/query/open_topics", {});
const result = unwrapQuery(raw);  // 忘了调就会输出 {ok, result} 包装
```

**问题**：
- 鸭子类型猜测（`"result" in raw`）不安全
- 消费端必须记得调用，遗漏即 bug
- 同一解包逻辑在每个 query 命令重复

**正确做法**：在传输层提供 `engineQuery`，query 端点专用，自动解包。

---

## 修复方案

### Fix 1: engine-client.ts 新增 `engineQuery`

```typescript
/**
 * Query 端点专用 POST。
 * Engine API 的 query/cmd 路由返回 {ok, result} 信封，
 * 此函数自动解包返回 result 字段。
 */
export async function engineQuery(path: string, body: unknown): Promise<unknown | null> {
  const raw = await enginePost(path, body);
  if (raw != null && typeof raw === "object" && "ok" in raw && "result" in raw) {
    return (raw as { result: unknown }).result;
  }
  return raw;
}
```

### Fix 2: irc.ts 消除 unwrapQuery

所有 `/query/*` 调用改用 `engineQuery`，删除 `unwrapQuery` 函数。

### Fix 3: 统一 output 调用

query 命令也用 `output(json, result, renderHuman(result))` 模式，
与 write 命令的 `output(json, result, renderConfirm(...))` 对称。

---

## 验证标准

- [ ] `irc threads` 输出编号列表，不是 `ok: true\nresult: [object Object]`
- [ ] `irc motd` 输出语义描述，不是 `{ok, result}` 包装
- [ ] `irc whois @target` 输出 key-value 画像
- [ ] `--json` 仍返回完整 JSON
- [ ] 其他 skill（alice-pkg, repeat-message, visit, google）不受影响（它们不用 engineQuery）
- [ ] typecheck + test 通过
