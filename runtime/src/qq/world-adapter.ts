/**
 * QQ 入站适配器（OneBot v11）：把消息和通知转成 AliceEvent，只记录 OneBot 给出的事实。
 *
 * 会话 id：qq:group:<群号>、qq:private:<QQ 号>。会话类型写在 id 里，pressure/reach.ts 的 privateScopeOf 能识别。
 * directed = 私聊，或 at 了她。QQ 的 at 是结构化的消息段，名字常是中文：at 的是别人时标上 mentionsOther，
 * 这样 pressure/group-filter.ts 就不用靠文字里的 @用户名 去猜。回复只记 replyToMessageId；回复的是不是她的消息
 * 由心智判断（mind/step.ts towardHer），和 Telegram 群里的回复处理相同。
 * 她自己的消息不从这里进时间线：外壳在发送成功后记 message.sent。
 */
import { z } from "zod";
import type {
  ChatDescribed,
  MemberJoined,
  MembershipChanged,
  MessagePerceived,
  MessageReceived,
  ReactionReceived,
} from "../mind/events.js";
import { Failed } from "../mind/failure.js";
import { describeMedia, type MediaFacts } from "../speech/media.js";

const QQ_PREFIX = "qq:";

export type QQTarget = { type: "group"; id: number } | { type: "private"; id: number };

export function groupScope(groupId: number | string): string {
  return `${QQ_PREFIX}group:${groupId}`;
}

export function privateScope(userId: number | string): string {
  return `${QQ_PREFIX}private:${userId}`;
}

/** 从会话 id 取出群号或 QQ 号。只接受 qq:group:<数字>、qq:private:<数字>；其他写法抛 Failed，不去猜。 */
export function targetOf(scope: string): QQTarget {
  const m = /^qq:(group|private):(\d+)$/.exec(scope);
  const id = m ? Number(m[2]) : Number.NaN;
  if (!m || !Number.isSafeInteger(id)) {
    throw new Failed({ reason: "peer_unreachable" }, `not a qq scope: ${scope}`);
  }
  return { type: m[1] as QQTarget["type"], id };
}

/** OneBot v11 的一个消息段。 */
export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

const CQ = /\[CQ:([\w.-]+)((?:,[^,\]]*)*)\]/g;
const unescapeText = (s: string) =>
  s.replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&amp;", "&");
const unescapeParam = (s: string) => unescapeText(s.replaceAll("&#44;", ","));

/** 把 CQ 码字符串（message_format 为 string 时）拆成消息段。 */
function parseCq(raw: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of raw.matchAll(CQ)) {
    if (m.index > last)
      out.push({ type: "text", data: { text: unescapeText(raw.slice(last, m.index)) } });
    const data: Record<string, unknown> = {};
    for (const pair of (m[2] ?? "").split(",").slice(1)) {
      const eq = pair.indexOf("=");
      if (eq > 0) data[pair.slice(0, eq)] = unescapeParam(pair.slice(eq + 1));
    }
    out.push({ type: m[1] ?? "unknown", data });
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push({ type: "text", data: { text: unescapeText(raw.slice(last)) } });
  return out;
}

/**
 * QQ 经典表情（face 段、贴表情的 emoji_id）里意思明确的几个，换成对应的 emoji；
 * 编号很大的是 Unicode 码位（QQ 的 emoji 表情）。其余的写成 [表情]。
 */
const FACES: Readonly<Record<string, string>> = {
  "5": "😭",
  "9": "😭",
  "13": "😁",
  "14": "🙂",
  "66": "❤",
  "76": "👍",
  "77": "👎",
  "124": "👌",
  "182": "😂",
};

function emojiOfFace(id: string): string | null {
  if (Object.hasOwn(FACES, id)) return FACES[id] ?? null;
  const n = Number(id);
  return Number.isInteger(n) && n > 0x2000 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

/** 贴表情时把 emoji 换成 OneBot 的 emoji_id：有对应经典表情的用它的编号，其余单个 emoji 用码位。 */
export function faceOfEmoji(emoji: string): string | null {
  if (emoji === "🤣") return "182";
  const known = Object.entries(FACES).find(([, e]) => e === emoji);
  if (known) return known[0];
  const points = [...emoji.replace(/\uFE0F/g, "")];
  const cp = points.length === 1 ? points[0]?.codePointAt(0) : undefined;
  return cp !== undefined && cp > 0x2000 ? String(cp) : null;
}

const id = z.union([z.number().transform(String), z.string().regex(/^-?\d+$/)]);
const segments = z.union([
  z.string().transform(parseCq),
  z
    .array(z.object({ type: z.string(), data: z.record(z.unknown()).nullish() }))
    .transform((list) => list.map((s) => ({ type: s.type, data: s.data ?? {} }))),
]);

const MessageEvent = z.object({
  post_type: z.literal("message"),
  message_type: z.enum(["private", "group"]),
  message_id: id,
  user_id: id,
  group_id: id.optional(),
  group_name: z.string().optional(),
  message: segments,
  sender: z
    .object({ nickname: z.string().optional(), card: z.string().optional() })
    .passthrough()
    .optional(),
});

const NoticeEvent = z
  .object({
    post_type: z.literal("notice"),
    notice_type: z.string(),
    sub_type: z.string().optional(),
    group_id: id.optional(),
    user_id: id.optional(),
    duration: z.number().optional(),
    message_id: id.optional(),
    likes: z.array(z.object({ emoji_id: z.union([z.string(), z.number()]) })).optional(),
  })
  .passthrough();

type Emitted =
  | MessageReceived
  | MessagePerceived
  | MembershipChanged
  | MemberJoined
  | ReactionReceived
  | ChatDescribed;

export interface QQAdapterOptions {
  selfId: string;
  /** 她在 QQ 上的名字（别人 at 她时写进文字）；不知道时用 QQ 号。 */
  selfName?: string;
  ignoredSenders?: ReadonlySet<string>;
  now: () => number;
  onEvent: (event: Emitted) => void;
  /**
   * 看图、听语音、看表情包：图片和表情包传 URL（下载后交给看图模型），语音传 OneBot 的文件名
   * （用 get_record 转成 ogg）。表情包另带能再发出去的 fileId 和去重用的 fileUniqueId，返回的是时间线里整行。
   * 结果稍后以 message.perceived 送来；不提供时只写"图片""语音""贴纸"。
   */
  perceive?: {
    image: (url: string) => Promise<string>;
    voice: (file: string) => Promise<string>;
    sticker: (sticker: QQSticker, url: string) => Promise<string>;
  };
  /**
   * 禁言状态变了（她自己被禁言或解除，全员禁言开启或关闭）：返回这个群新的资料（沿用已知的人数和管理员）。
   * bannedUntil 是禁言截止时间（解除时为 null）。
   */
  banChanged: (scope: string, bannedUntil: number | null, at: number) => ChatDescribed | null;
  /**
   * 这条消息是否第一次收到（收到过返回 false）：断线重连后 OneBot 可能把同一条再推一次；
   * 收到过的不再进时间线、不再看图，免得她回两遍。
   */
  firstSeen?: (scope: string, messageId: string) => boolean;
  warn?: (message: string, error: unknown) => void;
}

/** 一张 QQ 表情包：fileId 是再发它时用的地址，fileUniqueId 是去重的键（见 stickerKeyOf）。 */
export interface QQSticker {
  fileId: string;
  fileUniqueId?: string;
  emoji?: string;
}

/** 要看的图、表情包（URL）或要听的语音（文件名）。 */
type Look =
  | { kind: "image" | "voice"; ref: string }
  | { kind: "sticker"; ref: string; sticker: QQSticker };

interface Parsed {
  text: string | null;
  facts: MediaFacts | null;
  replyTo: string | null;
  atSelf: boolean;
  atOther: boolean;
  look: Look | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;

/** 去掉商城表情、动画表情说明文字（如 "[开心]"）外面的方括号。 */
const summaryOf = (v: unknown) =>
  str(v)
    ?.replace(/^\[|\]$/g, "")
    .trim() || undefined;

function mediaFactsOf(seg: Segment): MediaFacts | null {
  switch (seg.type) {
    case "image": {
      // sub_type 1 是表情包（自定义表情），按贴纸记录。
      const sticker = str(seg.data.sub_type) === "1";
      return sticker ? { type: "sticker", emoji: summaryOf(seg.data.summary) } : { type: "photo" };
    }
    case "mface":
    case "marketface":
      return { type: "sticker", emoji: summaryOf(seg.data.summary) };
    case "record":
      return { type: "voice" };
    case "video":
      return { type: "video" };
    case "file":
      return { type: "document", fileName: str(seg.data.name) ?? str(seg.data.file) };
    case "json":
    case "xml":
    case "share":
      return { type: "webpage", title: str(seg.data.title) };
    case "dice":
    case "rps":
      return { type: "dice" };
    default:
      return null;
  }
}

const MD5 = /[0-9a-f]{32}/i;

/**
 * QQ 表情包去重的键：OneBot 给了 file_unique 就用它；否则用图片的 MD5（文件名和下载地址里一般都有，
 * 下载地址里的签名每次不同，不能整个拿来当键）；商城表情用它的编号；都没有时用去掉扩展名的文件名。
 */
export function stickerKeyOf(seg: Segment): string | undefined {
  const emojiId = seg.type === "image" ? null : str(seg.data.emoji_id);
  if (emojiId) return `mface-${emojiId}`;
  const unique = str(seg.data.file_unique);
  if (unique) return unique.toLowerCase();
  const file = str(seg.data.file);
  const md5 = MD5.exec(file ?? "")?.[0] ?? MD5.exec(str(seg.data.url) ?? "")?.[0];
  if (md5) return md5.toLowerCase();
  return file?.replace(/\.[^.]*$/, "") || undefined;
}

/** sub_type 1 的图片（自定义表情）和带图的商城表情是表情包：交给看贴纸，按张缓存、收进 QQ 的贴纸库。 */
function stickerLookOf(seg: Segment): Look | null {
  const url = str(seg.data.url);
  const isSticker =
    (seg.type === "image" && str(seg.data.sub_type) === "1") ||
    seg.type === "mface" ||
    seg.type === "marketface";
  if (!url || !isSticker) return null;
  const fileUniqueId = stickerKeyOf(seg);
  const emoji = summaryOf(seg.data.summary);
  return {
    kind: "sticker",
    ref: url,
    sticker: {
      fileId: url,
      ...(fileUniqueId ? { fileUniqueId } : {}),
      ...(emoji ? { emoji } : {}),
    },
  };
}

function lookOf(seg: Segment): Look | null {
  const sticker = stickerLookOf(seg);
  if (sticker) return sticker;
  if (seg.type === "image") {
    const url = str(seg.data.url);
    return url ? { kind: "image", ref: url } : null;
  }
  if (seg.type === "record") {
    const file = str(seg.data.file);
    return file ? { kind: "voice", ref: file } : null;
  }
  return null;
}

function parse(list: readonly Segment[], options: QQAdapterOptions): Parsed {
  const parts: string[] = [];
  const out: Parsed = {
    text: null,
    facts: null,
    replyTo: null,
    atSelf: false,
    atOther: false,
    look: null,
  };
  for (const seg of list) {
    switch (seg.type) {
      case "text":
        parts.push(str(seg.data.text) ?? "");
        break;
      case "at": {
        const qq = str(seg.data.qq) ?? "";
        if (qq === "all") {
          out.atSelf = true;
          parts.push("@全体成员");
        } else if (qq === options.selfId) {
          out.atSelf = true;
          parts.push(`@${options.selfName ?? qq}`);
        } else {
          out.atOther = true;
          parts.push(`@${str(seg.data.name) ?? qq}`);
        }
        break;
      }
      case "reply":
        out.replyTo = str(seg.data.id);
        break;
      case "face":
        parts.push(emojiOfFace(str(seg.data.id) ?? "") ?? "[表情]");
        break;
      default: {
        out.facts ??= mediaFactsOf(seg);
        out.look ??= lookOf(seg);
      }
    }
  }
  const text = parts.join("").trim();
  out.text = text ? text.slice(0, 4096) : null;
  return out;
}

/**
 * QQ 官方机器人号段（开放平台 3889xxxxxx、腾讯官号 285419-285421xxxx）或官机 Markdown 卡片图床：
 * OneBot v11 协议本身没有 isBot 字段，靠协议级稳定特征补齐，与 Telegram 的 ctx.sender.isBot 对齐。
 */
const OFFICIAL_QQ_BOT_ID = /^(?:3889\d{6}|2854(?:19|20|21)\d{4})$/;
const QQ_BOT_MARKDOWN_URL = "https://qqbot.ugcimg.cn/";

function isOfficialQQBot(senderId: string, text: string | null): boolean {
  return OFFICIAL_QQ_BOT_ID.test(senderId) || (text?.includes(QQ_BOT_MARKDOWN_URL) ?? false);
}

function receivedOf(
  event: z.infer<typeof MessageEvent>,
  parsed: Parsed,
  at: number,
): MessageReceived {
  const isPrivate = event.message_type === "private";
  const senderId = String(event.user_id);
  const name = event.sender?.card || event.sender?.nickname || senderId;
  const { facts } = parsed;
  const bot = !isPrivate && isOfficialQQBot(senderId, parsed.text);
  return {
    type: "message.received",
    at,
    scope: isPrivate ? privateScope(event.user_id) : groupScope(event.group_id ?? "0"),
    chatType: isPrivate ? "private" : "group",
    messageId: String(event.message_id),
    senderId,
    senderName: name,
    ...(bot ? { isBot: true as const } : {}),
    text: parsed.text,
    contentType: facts?.type ?? "text",
    ...(facts ? { media: describeMedia(facts) } : {}),
    replyToMessageId: parsed.replyTo,
    directed: !bot && (isPrivate || parsed.atSelf),
    ...(!isPrivate && parsed.atOther && !parsed.atSelf ? { mentionsOther: true as const } : {}),
    ...(!isPrivate && event.group_name ? { chatTitle: event.group_name } : {}),
  };
}

function reportPerceived(
  received: MessageReceived,
  options: QQAdapterOptions,
  perceived: Promise<string>,
  label: (text: string) => string,
): void {
  void perceived
    .then((text) =>
      options.onEvent({
        type: "message.perceived",
        at: options.now(),
        scope: received.scope,
        messageId: received.messageId,
        media: label(text),
      }),
    )
    .catch((error: unknown) => {
      // 抛 Failed（如暂停时不看图）表示有意没做，不算出错。
      if (!(error instanceof Failed)) options.warn?.("Perception failed", error);
    });
}

function onMessage(event: z.infer<typeof MessageEvent>, options: QQAdapterOptions): void {
  const senderId = String(event.user_id);
  if (senderId === options.selfId || options.ignoredSenders?.has(senderId)) return;
  if (event.message_type === "group" && event.group_id === undefined) return;
  const parsed = parse(event.message, options);
  const received = receivedOf(event, parsed, options.now());
  if (options.firstSeen && !options.firstSeen(received.scope, received.messageId)) return;
  options.onEvent(received);
  const { look, facts } = parsed;
  const perceive = options.perceive;
  if (!look || !facts || !perceive) return;
  const label = describeMedia(facts);
  if (look.kind === "sticker") {
    reportPerceived(received, options, perceive.sticker(look.sticker, look.ref), (t) => t);
  } else if (look.kind === "image") {
    reportPerceived(received, options, perceive.image(look.ref), (t) => `${label}：${t}`);
  } else {
    reportPerceived(received, options, perceive.voice(look.ref), (t) => `${label}：“${t}”`);
  }
}

/** 一条群通知，以及解析它需要的上下文。 */
interface Notice {
  event: z.infer<typeof NoticeEvent>;
  at: number;
  scope: string;
  userId: string | null;
  options: QQAdapterOptions;
}

/** 入群：她自己入群记为 membership.changed，别人入群记为有人刚进群（member.joined）。 */
function groupIncrease({ event, at, scope, userId, options }: Notice): Emitted[] {
  if (userId === options.selfId) {
    const reason = event.sub_type === "invite" ? "added" : "joined";
    return [{ type: "membership.changed", at, scope, member: true, reason }];
  }
  return userId === null ? [] : [{ type: "member.joined", at, scope, userId }];
}

/** 退群：只记她自己的（被踢或主动退出）；别人退群或被踢不产生她的事件。 */
function groupDecrease({ event, at, scope, userId, options }: Notice): Emitted[] {
  if (event.sub_type !== "kick_me" && userId !== options.selfId) return [];
  const reason = event.sub_type === "leave" ? "left" : "kicked";
  return [{ type: "membership.changed", at, scope, member: false, reason }];
}

/** 禁言：她自己被禁言或解除，或全员禁言（user_id 为 0）。 */
function groupBan({ event, at, scope, userId, options }: Notice): Emitted[] {
  if (userId !== options.selfId && userId !== "0") return [];
  const seconds = event.duration ?? 0;
  const lifted = event.sub_type === "lift_ban" || seconds <= 0;
  const wholeGroup = userId === "0";
  const until = lifted ? null : wholeGroup ? Infinity : at + seconds * 1000;
  const described = options.banChanged(scope, until, at);
  return described ? [described] : [];
}

/** 有人在一条消息上贴了表情（NapCat 的 group_msg_emoji_like）。 */
function emojiLike({ event, at, scope, userId, options }: Notice): Emitted[] {
  if (userId === options.selfId || event.message_id === undefined) return [];
  const messageId = String(event.message_id);
  return (event.likes ?? []).flatMap((like) => {
    const emoji = emojiOfFace(String(like.emoji_id));
    return emoji
      ? [{ type: "reaction.received" as const, at, scope, messageId, senderId: userId, emoji }]
      : [];
  });
}

const NOTICES: Readonly<Record<string, (notice: Notice) => Emitted[]>> = {
  group_increase: groupIncrease,
  group_decrease: groupDecrease,
  group_ban: groupBan,
  group_msg_emoji_like: emojiLike,
};

function onNotice(event: z.infer<typeof NoticeEvent>, options: QQAdapterOptions): void {
  const handle = Object.hasOwn(NOTICES, event.notice_type) ? NOTICES[event.notice_type] : undefined;
  if (!handle || event.group_id === undefined) return;
  const notice: Notice = {
    event,
    at: options.now(),
    scope: groupScope(event.group_id),
    userId: event.user_id === undefined ? null : String(event.user_id),
    options,
  };
  for (const emitted of handle(notice)) options.onEvent(emitted);
}

/** 处理一个 OneBot 事件：能识别的转成 AliceEvent 交给 onEvent，其余丢弃。 */
export function createQQWorldAdapter(options: QQAdapterOptions): (raw: unknown) => void {
  return (raw) => {
    const message = MessageEvent.safeParse(raw);
    if (message.success) {
      onMessage(message.data, options);
      return;
    }
    const notice = NoticeEvent.safeParse(raw);
    if (notice.success) onNotice(notice.data, options);
  };
}
