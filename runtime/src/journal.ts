/**
 * Journal：唯一的事实来源，也是唯一写库的地方。送进 step() 的每个事件按顺序写一行
 * （payload 是完整的事件，ts 是事件的 at），启动时按同样顺序读回、fold 成状态。
 * 另外只写一张贴纸库（sticker_palette），它是外壳查 file_id 用的表，不是事件。
 *
 * 读回按事件类型查 zod schema。schema 和 mind/events.ts 的类型绑在一起（SCHEMAS 的类型约束）：events.ts
 * 给一种事件加了必填字段、schema 没跟上，类型检查就失败；加的是可选字段，读回时原样保留（passthrough），
 * 不会把新写的行当成读不懂的旧行悄悄跳过。
 */
import { z } from "zod";
import { getSqlite } from "./db/connection.js";
import { type Act, affordanceOf } from "./mind/affordances.js";
import { isAct } from "./mind/args.js";
import { SELF_SCOPE } from "./mind/effects.js";
import { type AliceEvent, type ClockTick, TONES } from "./mind/events.js";
import { FAILURES, type FailureCode } from "./mind/failure.js";

/** 引起了副作用的时钟格：scope 记第一个副作用所在的会话（只是日志行的键，fold 时按普通时钟格处理）。 */
type WokenTick = ClockTick & { scope: string };

/**
 * 时钟格只在它真的引起了什么（叫醒某个会话、请求想一想）时写进来（每 10 秒一格全写太多；
 * 只写这些格就足以在 fold 和回放里复现她那一刻为什么去找人）。
 */
export type JournaledEvent = Exclude<AliceEvent, ClockTick> | WokenTick;
type JournaledType = JournaledEvent["type"];

const text = z.string();
const textOrNull = z.string().nullable();
const act = z.custom<Act>((v) => isAct(v));
const reacted = z.object({ emoji: text, count: z.number().int().nonnegative() }).passthrough();
const usage = z
  .object({
    usd: z.number(),
    modelUsd: z.number(),
    searchUsd: z.number(),
    credits: z.number(),
    modelCalls: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    tools: z.record(z.number()),
    ms: z.number(),
  })
  .passthrough();

/** 每个事件都有的：类型、时刻、会话。 */
const event = <T extends JournaledType, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), at: z.number().finite(), scope: text, ...shape }).passthrough();

const place = z
  .object({
    scope: text,
    kind: z.enum(["group", "channel"]),
    title: text,
    about: textOrNull,
    members: z.number().nullable(),
    recent: z.array(text),
  })
  .passthrough();

const reflectPonder = z
  .object({
    kind: z.literal("reflect"),
    scope: text,
    entries: z.array(
      z
        .object({
          about: textOrNull,
          text,
          importance: z.number().int().min(1).max(10).nullable(),
          private: z.literal(true).optional(),
        })
        .passthrough(),
    ),
    mood: z
      .object({
        word: text,
        why: textOrNull,
        valence: z.number().finite().optional(),
        private: z.literal(true).optional(),
      })
      .passthrough()
      .optional(),
    learned: z
      .object({
        facts: z
          .array(
            z
              .object({
                about: text,
                text,
                when: textOrNull,
                replaces: textOrNull,
                private: z.literal(true).optional(),
              })
              .passthrough(),
          )
          .optional(),
        self: z
          .array(
            z
              .object({
                text,
                replaces: textOrNull,
                private: z.literal(true).optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const lifePonder = z
  .object({
    kind: z.literal("life"),
    date: text,
    activities: z.record(text.optional()),
    moments: z.array(z.object({ hour: z.number().finite(), text }).passthrough()),
    ongoing: z.array(text),
    curiosities: z.array(z.object({ topic: text, hook: text }).passthrough()).optional(),
  })
  .passthrough();

const ponder = z.discriminatedUnion("kind", [reflectPonder, lifePonder]);

/**
 * 2026-11-12 之前写下的反思结果把 facts、likes、group 平铺在 ponder 上：读回时把 facts 收进 learned；
 * likes（R07）、group（R08）已经拿掉，丢弃。
 */
function liftLearned(payload: unknown): unknown {
  const row = payload as { ponder?: Record<string, unknown> };
  const p = row?.ponder;
  if (p?.kind !== "reflect" || p.learned !== undefined) return payload;
  const { facts, likes, group, ...rest } = p;
  if (facts === undefined && likes === undefined && group === undefined) return payload;
  return { ...row, ponder: { ...rest, learned: facts !== undefined ? { facts } : {} } };
}

/**
 * 2026-11-12 之前写的失败原因是字符串：后台的事写她看到的话，调用失败写报错文字。读回时换成码
 * （mind/failure.ts），原来的字留在 said / error 里。
 */
const LEGACY_SAID: Record<string, Exclude<FailureCode, "errand">> = {
  中途断了: "interrupted",
  现在办不了这种事: "paused",
  现在查不了: "unavailable",
};

function liftActFailure(payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  const reason = p?.reason;
  if (typeof reason !== "string" || reason in FAILURES || !isAct(p.act)) return payload;
  const legacy = LEGACY_SAID[reason];
  if (legacy) return { ...p, reason: legacy };
  return affordanceOf(p.act.kind).via === "errand"
    ? { ...p, reason: "errand", said: reason }
    : { ...p, reason: "outcome_unknown" };
}

const CALL_FAILURES: ReadonlySet<unknown> = new Set(["model", "interrupted", "paused"]);

function liftCallFailure(payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  if (typeof p?.reason !== "string" || CALL_FAILURES.has(p.reason)) return payload;
  return { ...p, reason: "model", error: p.reason };
}

const callFailure = z.enum(["model", "interrupted", "paused"]);
const failureCode = z.enum(Object.keys(FAILURES) as [FailureCode, ...FailureCode[]]);
const actBase = { act, usage: usage.optional() };

/** 每种事件读回的样子；类型约束保证它和 mind/events.ts 的类型对得上。 */
const SCHEMAS: {
  [T in JournaledType]: z.ZodType<Extract<JournaledEvent, { type: T }>, z.ZodTypeDef, unknown>;
} = {
  "message.received": event("message.received", {
    chatType: z.enum(["private", "group"]),
    messageId: text,
    senderId: text,
    senderName: text,
    text: textOrNull,
    contentType: text,
    media: text.optional(),
    replyToMessageId: textOrNull,
    directed: z.boolean(),
    mentionsOther: z.literal(true).optional(),
    chatTitle: text.optional(),
    isBot: z.literal(true).optional(),
    forwardedFrom: text.optional(),
    stickerSet: text.optional(),
    edited: z.literal(true).optional(),
    reactions: z.array(reacted).optional(),
  }),
  "message.updated": event("message.updated", {
    messageId: text,
    text: textOrNull.optional(),
    edited: z.literal(true).optional(),
    reactions: z.array(reacted).optional(),
    stickerSet: text.optional(),
  }),
  "chat.described": event("chat.described", {
    members: z.number().int().nullable(),
    admins: z.array(
      z
        .object({
          id: text,
          name: text,
          role: z.enum(["owner", "admin"]),
          title: text.optional(),
        })
        .passthrough(),
    ),
    banned: z.array(z.enum(["text", "sticker", "photo", "voice", "forward"])),
  }),
  "message.perceived": event("message.perceived", {
    messageId: text,
    media: text.optional(),
    tone: z.enum(TONES).optional(),
    stop: z.literal(true).optional(),
    hush: z.literal(true).optional(),
    aloof: z.literal(true).optional(),
  }),
  "post.received": event("post.received", {
    messageId: text,
    title: text,
    text: textOrNull,
    media: text.optional(),
  }),
  "message.sent": event("message.sent", {
    messageId: text,
    text,
    kind: z.enum(["text", "sticker", "photo", "voice", "forward"]),
  }),
  "speech.decided": event("speech.decided", {
    callId: text,
    decision: z.object({ acts: z.array(act) }).passthrough(),
  }),
  "speech.failed": z.preprocess(
    liftCallFailure,
    event("speech.failed", { callId: text, reason: callFailure, error: text.optional() }),
  ),
  "ponder.done": z.preprocess(liftLearned, event("ponder.done", { callId: text, ponder })),
  "ponder.failed": z.preprocess(
    liftCallFailure,
    z.union([
      event("ponder.failed", {
        callId: text,
        reason: callFailure,
        error: text.optional(),
        kind: z.literal("reflect"),
        chat: text,
      }),
      event("ponder.failed", {
        callId: text,
        reason: callFailure,
        error: text.optional(),
        kind: z.literal("life"),
      }),
    ]),
  ),
  "act.started": event("act.started", { act }),
  "act.done": event("act.done", {
    ...actBase,
    result: text.optional(),
    // 找群看到的群和频道是后来加的：旧行没有。
    found: z.array(place).optional(),
    valence: z.number().finite().optional(),
  }),
  "act.failed": z.preprocess(
    liftActFailure,
    z.union([
      event("act.failed", { ...actBase, reason: z.literal("errand"), said: text }),
      event("act.failed", {
        ...actBase,
        reason: failureCode.exclude(["errand"]),
        rpc: text.optional(),
        dmClosed: z.literal(true).optional(),
      }),
    ]),
  ),
  "timer.fired": event("timer.fired", { timerId: text }),
  "reaction.received": event("reaction.received", {
    messageId: text,
    senderId: textOrNull,
    emoji: text,
  }),
  "membership.changed": event("membership.changed", {
    member: z.boolean(),
    reason: z.enum(["kicked", "left", "added", "joined"]),
  }),
  "clock.tick": event("clock.tick", {}),
  "noise.drawn": event("noise.drawn", {
    scope: z.literal(SELF_SCOPE),
    draws: z.record(z.number()),
  }),
  "member.joined": event("member.joined", { userId: text }),
  "arm.switched": event("arm.switched", {
    arm: z.enum(["production", "candidate"]).nullable(),
    candidate: text,
    block: z.number().int(),
  }),
  "typing.received": event("typing.received", {
    chatType: z.enum(["private", "group"]),
    senderId: text,
    status: z.enum(["typing", "voice", "cancel"]),
  }),
  "history.read": event("history.read", {
    chatType: z.enum(["private", "group"]),
    outbox: z.boolean(),
    maxReadId: text,
    unreadCount: z.number().int().nonnegative(),
  }),
};

const EVENT_TYPES = Object.keys(SCHEMAS) as JournaledType[];

/**
 * 把一行读回成事件。8 月运行时在同一张表里写过同名类型（如 message.received）但形状不同，
 * 它们的 payload 里没有 type 字段（或类型、会话和行对不上），在这里返回 null。
 */
export function decodeEvent(type: string, scope: string, payload: unknown): AliceEvent | null {
  // 库里的 type 是外来字符串："toString" 这类原型上的名字也要当成认不出。
  if (!Object.hasOwn(SCHEMAS, type)) return null;
  const schema = SCHEMAS[type as JournaledType];
  const parsed = schema.safeParse(payload);
  if (!parsed.success || parsed.data.type !== type || parsed.data.scope !== scope) return null;
  return parsed.data;
}

export function appendEvent(event: JournaledEvent): number {
  if (!event.scope.trim()) throw new Error("Journal event scope must not be empty");
  if (!Number.isFinite(event.at)) throw new TypeError("Journal event at must be a finite epoch ms");
  const result = getSqlite()
    .prepare("INSERT INTO journal_events (type, scope, payload, ts) VALUES (?, ?, ?, ?)")
    .run(event.type, event.scope, JSON.stringify(event), event.at);
  return Number(result.lastInsertRowid);
}

/** 按写入顺序逐个读出事件；读不懂的行（旧运行时写的）计入 skipped。 */
export function forEachEvent(visit: (event: AliceEvent) => void): {
  read: number;
  skipped: number;
} {
  const rows = getSqlite()
    .prepare(
      `SELECT type, scope, payload FROM journal_events
       WHERE type IN (${EVENT_TYPES.map(() => "?").join(", ")}) ORDER BY id`,
    )
    .iterate(...EVENT_TYPES) as Iterable<{ type: string; scope: string; payload: string }>;
  let read = 0;
  let skipped = 0;
  for (const row of rows) {
    const event = decodeEvent(row.type, row.scope, JSON.parse(row.payload));
    if (!event) {
      skipped++;
      continue;
    }
    read++;
    visit(event);
  }
  return { read, skipped };
}

/** 贴纸库里的一行（sticker_palette）。外壳发贴纸时按它找 file_id；它不是事件，不进 fold。 */
export interface StickerRow {
  fileId: string;
  fileUniqueId: string;
  label: string;
  emoji: string | null;
  setName: string | null;
  emotion: string;
  action: string;
}

/** 各平台的贴纸各占一份（platform 列）：同一个 file_unique_id 在 Telegram 和 QQ 上是两张贴纸。 */
const STICKER_TABLE = `CREATE TABLE IF NOT EXISTS sticker_palette (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  label text NOT NULL,
  file_id text NOT NULL,
  file_unique_id text NOT NULL,
  emoji text,
  set_name text,
  emotion text,
  action text,
  intensity text,
  created_at integer NOT NULL,
  platform text NOT NULL DEFAULT 'telegram'
)`;

/** 旧库的贴纸库没有 platform 列：补上，已有的行都是 Telegram 的。 */
function migrateStickerTable(): void {
  const db = getSqlite();
  const columns = db.pragma("table_info(sticker_palette)") as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((c) => c.name === "platform")) {
    db.exec("ALTER TABLE sticker_palette ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'");
  }
}

/** 库里有没有贴纸库（有就顺带补齐 platform 列，读的一方才能按平台筛）。 */
export function hasStickerTable(): boolean {
  const exists =
    getSqlite()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sticker_palette'")
      .get() !== undefined;
  if (exists) migrateStickerTable();
  return exists;
}

/** 看懂一张贴纸后记进这个平台的贴纸库：已有这张就换说明，没有就新加一行。 */
export function putSticker(row: StickerRow, at: number, platform = "telegram"): void {
  const db = getSqlite();
  db.exec(STICKER_TABLE);
  migrateStickerTable();
  const updated = db
    .prepare(
      `UPDATE sticker_palette
          SET file_id = ?, label = ?, emoji = COALESCE(?, emoji), set_name = COALESCE(?, set_name),
              emotion = ?, action = ?
        WHERE file_unique_id = ? AND platform = ?`,
    )
    .run(
      row.fileId,
      row.label,
      row.emoji,
      row.setName,
      row.emotion,
      row.action,
      row.fileUniqueId,
      platform,
    );
  if (updated.changes > 0) return;
  db.prepare(
    `INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity, created_at, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', ?, ?)`,
  ).run(
    row.label,
    row.fileId,
    row.fileUniqueId,
    row.emoji,
    row.setName,
    row.emotion,
    row.action,
    at,
    platform,
  );
}

/** 换掉这个平台贴纸库里一张贴纸的说明（启动时按看图缓存补全）。 */
export function relabelSticker(
  fileUniqueId: string,
  label: string,
  emotion: string,
  action: string,
  platform = "telegram",
): void {
  migrateStickerTable();
  getSqlite()
    .prepare(
      "UPDATE sticker_palette SET label = ?, emotion = ?, action = ? WHERE file_unique_id = ? AND platform = ?",
    )
    .run(label, emotion, action, fileUniqueId, platform);
}
