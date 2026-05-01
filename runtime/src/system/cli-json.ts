/**
 * CLI JSON 字段选择 — GitHub CLI 风格（ADR-239）。
 *
 * --json 接受逗号分隔字段列表，无效字段报错并列出可用字段。
 * 与 GitHub CLI 行为一致：`gh issue list --json invalid` → 报错。
 *
 * FP 设计原则：
 * - discriminated union 表达输出模式
 * - as const 保证不可变
 * - 泛型保持类型信息
 */

// ── Output Mode (Sum Type) ──

/** 输出模式 — discriminated union，编译期强制覆盖。 */
export type OutputMode =
  | { type: "human" } // 人类可读文本
  | { type: "json"; fields: string[] | undefined }; // JSON 模式；fields=undefined 表示全字段

/** 从 --json 参数解析输出模式。 */
export function parseOutputMode(
  command: CommandName | string,
  jsonArg: string | undefined,
): OutputMode {
  // 无参数 → 人类可读
  if (jsonArg === undefined) return { type: "human" };

  // 空字符串 → JSON 全字段
  if (jsonArg === "") return { type: "json", fields: undefined };

  const requested = jsonArg
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  // 检查命令是否在注册表中
  const available = command in COMMAND_FIELDS ? COMMAND_FIELDS[command as CommandName] : undefined;

  // 命令未注册 → 允许任意字段
  if (!available) {
    return { type: "json", fields: requested.length > 0 ? requested : undefined };
  }

  // 验证字段 — 用 Set 提高可读性
  const validSet = new Set<string>(available);
  const invalid = requested.filter((f) => !validSet.has(f));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown JSON field: ${invalid.map((f) => `"${f}"`).join(", ")}\n` +
        `Available fields:\n  ${available.join("\n  ")}`,
    );
  }

  return { type: "json", fields: requested };
}

// ── Field Registry (Immutable) ──

/** 命令可用字段注册表 — as const 保证不可变。 */
export const COMMAND_FIELDS = {
  // 核心命令
  say: ["msgId", "chatId"] as const,
  reply: ["msgId", "chatId", "replyTo"] as const,
  react: ["success", "chatId", "msgId"] as const,
  sticker: ["msgId", "chatId"] as const,
  voice: ["msgId", "chatId"] as const,
  read: ["success"] as const,
  join: ["success", "chatId"] as const,
  leave: ["success"] as const,
  "send-file": ["msgId", "chatId", "path"] as const,
  download: ["path", "mime", "size"] as const,
  forward: ["forwardedMsgId", "commentMsgId"] as const,
  "album-search": [
    "assetId",
    "sourceChatId",
    "sourceMsgId",
    "captionText",
    "description",
    "wdTagsJson",
    "ocrText",
    "sourceStatus",
    "score",
    "snippet",
  ] as const,
  "album-send": ["msgId", "chatId", "assetId", "sendMode"] as const,

  // 查询命令
  whois: ["chatId", "name", "chatType", "topic", "unread", "pendingDirected", "role"] as const,
  motd: ["mood", "valence", "tension"] as const,
  tail: [
    "id",
    "sender",
    "senderId",
    "text",
    "mediaType",
    "outgoing",
    "directed",
    "timestamp",
  ] as const,
  threads: ["id", "title", "priority", "status"] as const,
  topic: ["chatId", "topic"] as const,
} as const;

/** 命令名类型 — 从注册表推导，消除魔法字符串。 */
export type CommandName = keyof typeof COMMAND_FIELDS;

// ── Output Filtering (Generic) ──

/** 过滤对象，只保留指定字段。泛型保持类型信息。 */
export function filterFields<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[] | undefined,
): Partial<T> {
  if (!fields || fields.length === 0) return obj;
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (fields.includes(key as string)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/** 过滤数组元素。 */
export function filterArrayFields<T extends Record<string, unknown>>(
  arr: T[],
  fields: readonly string[] | undefined,
): Partial<T>[] {
  if (!fields || fields.length === 0) return arr;
  return arr.map((item) => filterFields(item, fields));
}

/** 统一过滤入口 — 处理单个对象或数组。 */
export function filterOutput<T extends Record<string, unknown>>(
  data: T | T[],
  fields: readonly string[] | undefined,
): Partial<T> | Partial<T>[] {
  return Array.isArray(data) ? filterArrayFields(data, fields) : filterFields(data, fields);
}
