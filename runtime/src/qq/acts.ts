/**
 * 动作登记表里经平台执行的动作，在 QQ（OneBot v11）上的实现。QQ 做不了的（改消息、找群、按链接加群、
 * 转发）抛 Failed unavailable：确定没执行，下一轮由她自己决定怎么办。
 */
import type { Album } from "../album.js";
import { type Act, affordanceOf } from "../mind/affordances.js";
import { Failed } from "../mind/failure.js";
import type { ActOutcome } from "../mind/outcome.js";
import { typingMs } from "../utils/typing.js";
import type { QQ } from "./gates.js";
import { faceOfEmoji, type QQTarget, type Segment, targetOf } from "./world-adapter.js";

export type QQPrivateRoute =
  | { kind: "direct" }
  | { kind: "temp"; groupId: number }
  | { kind: "closed" };

export interface QQActContext {
  qq: QQ;
  scope: string;
  /** 这个会话里最近收到的一条消息的编号（SnowLuma 等 OneBot 实现标已读时要传它）。 */
  lastMessageId?: number;
  /** 发私聊前的本地路由判断：好友直发、同群非好友走临时私聊、明确不可达则本地提前拦截不撞风控。 */
  privateRoute?: (userId: number) => Promise<QQPrivateRoute> | QQPrivateRoute;
  /** 某群的临时私聊被拒时回调，记住该群不允许临时私聊。 */
  onTempPrivateRejected?: (groupId: number) => void;
  /** 把一句话合成语音（llm/tts.ts）。 */
  speak: (text: string) => Promise<{ ogg: Uint8Array }>;
  /** 等待一段时间（发文字前模拟"正在输入"的那几秒）。 */
  pause: (ms: number) => Promise<void>;
  /** 贴纸词 → QQ 贴纸库里一张表情包的地址（sticker-palette.ts）；对不上时是 null。 */
  stickerFileId: (word: string) => string | null;
  /** 她在 QQ 群里见过的图。 */
  album: Album;
  now: () => number;
}

const DONE: ActOutcome = { kind: "done" };

/**
 * 复读时原样重发的消息段：文字、表情、图片。at（包括 @全体成员）、回复、转发和卡片不复读：
 * 跟着复读一句话，不该顺带替她去 @ 人。
 */
const ECHOABLE: ReadonlySet<string> = new Set(["text", "face", "image", "mface"]);

function posted(data: unknown): ActOutcome {
  const id = (data as { message_id?: unknown } | null)?.message_id;
  // 没拿到 id 不代表没发出去：按结果未知处理，不重发。
  if (typeof id !== "number" && typeof id !== "string") {
    throw new TypeError("OneBot did not return a message id");
  }
  return { kind: "posted", messageId: String(id) };
}

const unavailable = (kind: string) =>
  new Failed({ reason: "unavailable" }, `${kind} is not available on QQ`);

async function sendSegments(
  ctx: QQActContext,
  target: QQTarget,
  message: readonly Segment[],
): Promise<ActOutcome> {
  const isPrivate = target.type === "private";
  if (!isPrivate) {
    const data = await ctx.qq.post(
      ctx.scope,
      "send_group_msg",
      { group_id: target.id, message },
      false,
    );
    return posted(data);
  }
  const route = (await ctx.privateRoute?.(target.id)) ?? { kind: "direct" };
  if (route.kind === "closed") {
    throw new Failed(
      { reason: "private_closed", dmClosed: true },
      "not a QQ friend and no temporary group chat available",
    );
  }
  const params =
    route.kind === "temp"
      ? { user_id: target.id, group_id: route.groupId, message }
      : { user_id: target.id, message };
  try {
    const data = await ctx.qq.post(ctx.scope, "send_private_msg", params, true);
    return posted(data);
  } catch (error) {
    if (
      route.kind === "temp" &&
      error instanceof Failed &&
      error.failure.reason === "private_closed"
    ) {
      ctx.onTempPrivateRejected?.(route.groupId);
    }
    throw error;
  }
}

function messageIdOf(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Failed({ reason: "message_gone" }, `not a QQ message id: ${raw}`);
  }
  return n;
}

type Executor<K extends Act["kind"]> = (
  ctx: QQActContext,
  target: QQTarget,
  act: Extract<Act, { kind: K }>,
) => Promise<ActOutcome>;

async function synthesize(ctx: QQActContext, text: string): Promise<Uint8Array> {
  try {
    return (await ctx.speak(text)).ogg;
  } catch (error) {
    // 合成因停机而中止：什么也没发出去，按中止的原因记录。
    ctx.qq.signal.throwIfAborted();
    if (error instanceof Failed) throw error;
    throw new Failed({ reason: "voice_failed" }, "speech synthesis failed");
  }
}

function nothingToMark(error: unknown): boolean {
  if (!(error instanceof Failed)) return false;
  const { failure } = error;
  if (failure.reason === "message_gone") return true;
  return failure.reason === "unavailable" && "rpc" in failure && failure.rpc !== undefined;
}

/** QQ 上能执行的动作；不在表里的一律 unavailable。 */
const executors: { [K in Act["kind"]]?: Executor<K> } = {
  send: async (ctx, target, act) => {
    const reply: Segment[] = act.replyTo ? [{ type: "reply", data: { id: act.replyTo } }] : [];
    // 模拟发送前"正在输入"的那几秒：OneBot 没有输入状态接口，只能干等。
    await ctx.pause(typingMs(act.text));
    return sendSegments(ctx, target, [...reply, { type: "text", data: { text: act.text } }]);
  },
  react: async (ctx, target, act) => {
    const emojiId = target.type === "group" ? faceOfEmoji(act.emoji) : null;
    if (emojiId === null) {
      throw new Failed({ reason: "invalid_reaction" }, `no QQ reaction ${act.emoji} here`);
    }
    await ctx.qq.request("set_msg_emoji_like", {
      message_id: messageIdOf(act.messageId),
      emoji_id: emojiId,
    });
    return DONE;
  },
  // 表情包按图片发，sub_type 1 让对方看到的是表情包而不是一张照片。
  sticker: async (ctx, target, act) => {
    const file = ctx.stickerFileId(act.word);
    if (file === null) {
      throw new Failed({ reason: "invalid_sticker_keyword" }, `no QQ sticker for ${act.word}`);
    }
    return sendSegments(ctx, target, [{ type: "image", data: { file, sub_type: 1 } }]);
  },
  // 看了才知道的动作：返回的是她看到的东西（act.done 的 result），不是消息 id。
  "album-search": async (ctx, _target, act) => ({
    kind: "looked",
    text: await ctx.album.search(act.query, ctx.now(), "qq:"),
    found: [],
  }),
  // 发相册里的一张：取出原消息里的图，再发一次（QQ 没有"不带原作者转发"）。
  "album-send": async (ctx, target, act) => {
    const photo = ctx.album.source(act.asset);
    if (!photo?.scope.startsWith("qq:")) {
      throw new Failed({ reason: "invalid_asset" }, `no album photo ${act.asset}`);
    }
    const original = await ctx.qq.request<{ message?: unknown }>("get_msg", {
      message_id: messageIdOf(photo.messageId),
    });
    const segments = Array.isArray(original?.message) ? (original.message as Segment[]) : [];
    const image = segments.find((s) => s.type === "image");
    const file = image?.data.url ?? image?.data.file;
    if (typeof file !== "string" || !file) {
      throw new Failed({ reason: "message_gone" }, "no image in the album message");
    }
    return sendSegments(ctx, target, [{ type: "image", data: { file } }]);
  },
  voice: async (ctx, target, act) => {
    const ogg = await synthesize(ctx, act.text);
    const file = `base64://${Buffer.from(ogg).toString("base64")}`;
    return sendSegments(ctx, target, [{ type: "record", data: { file } }]);
  },
  // 复读：取出那条消息的消息段，原样再发一次。
  repeat: async (ctx, target, act) => {
    const original = await ctx.qq.request<{ message?: unknown }>("get_msg", {
      message_id: messageIdOf(act.messageId),
    });
    const segments = Array.isArray(original?.message) ? (original.message as Segment[]) : [];
    const copy = segments.filter((s) => ECHOABLE.has(s.type));
    if (copy.length === 0) throw new Failed({ reason: "message_gone" }, "nothing to repeat");
    return sendSegments(ctx, target, copy);
  },
  "leave-chat": async (ctx, target) => {
    if (target.type !== "group") throw unavailable("leaving a private chat");
    await ctx.qq.request("set_group_leave", { group_id: target.id });
    return DONE;
  },
  // 撤回自己刚发的消息（QQ 不能改消息，但支持 2 分钟内撤回）。
  unsend: async (ctx, _target, act) => {
    await ctx.qq.request("delete_msg", { message_id: messageIdOf(act.messageId) });
    return DONE;
  },
  // 标记会话已读（SnowLuma / NapCat 扩展：mark_private_msg_as_read / mark_group_msg_as_read）。
  // OneBot 回复不支持这个动作（1404，带 rpc），或那条消息已经不在了：没有可标的，算作完成
  // （免得她以为自己没做成）。没连上（不带 rpc 的 unavailable）仍然抛出。
  "mark-read": async (ctx, target) => {
    const msg = ctx.lastMessageId !== undefined ? { message_id: ctx.lastMessageId } : {};
    try {
      if (target.type === "private") {
        await ctx.qq.request("mark_private_msg_as_read", { user_id: target.id, ...msg });
      } else {
        await ctx.qq.request("mark_group_msg_as_read", { group_id: target.id, ...msg });
      }
    } catch (error) {
      if (!nothingToMark(error)) throw error;
    }
    return DONE;
  },
};

/** 在 QQ 上执行一个动作。抛 Failed 表示确定没做成，其他错误表示结果未知。 */
export async function executeQQAct(ctx: QQActContext, act: Act): Promise<ActOutcome> {
  if (affordanceOf(act.kind).via !== "telegram") {
    throw new Error(`act has no platform effect: ${act.kind}`);
  }
  const run = executors[act.kind] as Executor<Act["kind"]> | undefined;
  if (!run) throw unavailable(act.kind);
  return run(ctx, targetOf(ctx.scope), act);
}
