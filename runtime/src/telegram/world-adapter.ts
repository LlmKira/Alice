import type { Dispatcher } from "@mtcute/dispatcher";
import {
  getMarkedPeerId,
  type Message,
  type MessageMedia,
  type TelegramClient,
  type tl,
  User,
} from "@mtcute/node";
import type {
  HistoryRead,
  MemberJoined,
  MembershipChanged,
  MessagePerceived,
  MessageReceived,
  MessageUpdated,
  PostReceived,
  Reacted,
  ReactionReceived,
  TypingReceived,
} from "../mind/events.js";
import { Failed } from "../mind/failure.js";
import { describeMedia, type MediaFacts } from "../speech/media.js";
import { TelegramActionError } from "./errors.js";
import { reactedOf } from "./scene.js";

const SCOPE_PREFIX = "telegram:";

export function scopeOf(chatId: string | number): string {
  return `${SCOPE_PREFIX}${chatId}`;
}

/**
 * 只有邀请链接、不知道 id 的群（找群时 checkChatInvite 只给了预览）：会话写成 telegram:+<邀请码>，
 * 加入时按链接加（acts.ts）。加入之后群的消息按真实 id 进来，这个会话从此空着。
 */
export function inviteScope(hash: string): string {
  return `${SCOPE_PREFIX}+${hash}`;
}

/** 邀请写法的会话 → 邀请码；不是这种写法时为 null。 */
export function inviteOf(scope: string): string | null {
  const m = scope.startsWith(`${SCOPE_PREFIX}+`) ? scope.slice(SCOPE_PREFIX.length + 1) : null;
  return m && /^[\w-]+$/.test(m) ? m : null;
}

/** 会话 → Telegram 数字 id。只认 telegram:<整数>，其他写法直接拒绝，不猜。 */
export function chatIdOf(scope: string): number {
  const id = scope.startsWith(SCOPE_PREFIX) ? Number(scope.slice(SCOPE_PREFIX.length)) : Number.NaN;
  if (!Number.isSafeInteger(id) || scopeOf(id) !== scope) {
    throw new TelegramActionError("peer_unreachable", `not a telegram scope: ${scope}`);
  }
  return id;
}

/** 动作作用的会话：数字 id，或者只有邀请链接的群（只能按链接加入）。认不出的写法是带类型的失败。 */
export function targetOf(scope: string): { chatId: number } | { invite: string } {
  const invite = inviteOf(scope);
  return invite ? { invite } : { chatId: chatIdOf(scope) };
}

/** 超过这么长的语音不转写（只写时长），免得一条长语音占满提示词。 */
const VOICE_MAX_SECONDS = 120;

/** 静态的缩略图（不含模糊条、轮廓和视频缩略图）。 */
const RASTER_THUMBS = new Set(["s", "m", "x", "y", "w", "a", "b", "c", "d"]);

/** 贴纸的画面：静态贴纸直接取原图，动态/视频贴纸取 Telegram 给的最大静态缩略图。 */
function stickerFrame(media: MessageMedia) {
  if (media?.type !== "sticker") return null;
  if (media.sourceType === "static") return media;
  const frames = media.thumbnails.filter((t) => RASTER_THUMBS.has(t.type));
  return frames.reduce<(typeof frames)[number] | null>(
    (best, t) => (best === null || t.width > best.width ? t : best),
    null,
  );
}
/** 动图、视频的预览帧：Telegram 随文件给的静态缩略图里最大的一张（2 月同样取它，不用下载整段视频）。 */
function previewFrame(media: MessageMedia) {
  if (media?.type !== "video") return null;
  const frames = media.thumbnails.filter((t) => RASTER_THUMBS.has(t.type));
  return frames.reduce<(typeof frames)[number] | null>(
    (best, t) => (best === null || t.width > best.width ? t : best),
    null,
  );
}

/** Telegram 随消息给的、描述非文字部分的字段（零调用感知）。 */
function mediaFacts(media: MessageMedia): MediaFacts | null {
  if (!media) return null;
  switch (media.type) {
    case "sticker":
      return { type: media.type, emoji: media.emoji };
    case "voice":
      return { type: media.type, seconds: media.duration };
    case "video":
      return {
        type: media.type,
        seconds: media.duration,
        round: media.isRound,
        animation: media.isAnimation,
      };
    case "audio":
      return {
        type: media.type,
        seconds: media.duration,
        title: media.title,
        performer: media.performer,
      };
    case "document":
      return { type: media.type, fileName: media.fileName };
    case "webpage":
      return {
        type: media.type,
        title: media.preview.title,
        description: media.preview.description,
        siteName: media.preview.siteName,
      };
    case "poll":
      return { type: media.type, question: media.question };
    case "dice":
      return { type: media.type, emoji: media.emoji };
    default:
      return { type: media.type };
  }
}

/** 入群提示里进群的人（被拉进来的，或自己点链接进来的发送者）；不是入群提示时为 null。 */
function joinedBy(action: Message["action"], senderId: string): string[] | null {
  switch (action?.type) {
    case "users_added":
      return action.users.map(String);
    case "user_joined_link":
    case "user_joined_approved":
    case "user_joined_community":
      return [senderId];
    default:
      return null;
  }
}

/** 退群提示里离开的人（自己退的是发送者，被移出的是提示里的那个人）；不是退群提示时为 null。 */
function leftBy(
  action: Message["action"],
  senderId: string,
): { userId: string; reason: "left" | "kicked" } | null {
  switch (action?.type) {
    case "user_left":
      return { userId: senderId, reason: "left" };
    case "user_removed":
      return { userId: String(action.user), reason: "kicked" };
    default:
      return null;
  }
}

/** mtcute 解析过的表情合计（ReactionEmoji 是 emoji 或自定义表情的编号，只留 emoji）。 */
function reactionsOf(msg: Message): Reacted[] {
  return (msg.reactions?.reactions ?? []).flatMap((r) =>
    typeof r.emoji === "string" ? [{ emoji: r.emoji, count: r.count }] : [],
  );
}

/** 真的改过（Telegram 标了不显示"已编辑"的不算：点表情也会给消息记一个编辑时刻）。 */
const editedOf = (msg: Message) => Boolean(msg.editDate) && !msg.hideEditMark;

/** 看图、听语音要先把文件下下来。 */
type Downloader = Pick<TelegramClient, "downloadAsBuffer">;

/**
 * 入站适配：把新消息转成 MessageReceived，只记 Telegram 给的事实。directed = 私聊、点名了 Alice、或 Telegram
 * 说了被回复的那条是她的（跨会话的回复才带发送者）。同一个群里回复她的某一条，Telegram 不给被回复者
 * （mtcute same_chat），只记下 replyToMessageId，算不算找她由心智定（mind/step.ts towardHer）。
 * 她自己发出的消息不在这里进时间线：mtcute 不派发本客户端自己发出的消息，由外壳在发送成功后记 message.sent。
 */
export function bindTelegramWorldAdapter(
  dispatcher: Dispatcher,
  options: {
    selfId: string;
    selfUsername?: string;
    /** 不进入时间线的发送者 id（config：ALICE_IGNORED_SENDERS，逗号分隔；真实 id 不进仓库）。 */
    ignoredSenders?: ReadonlySet<string>;
    now(): number;
    onEvent(
      event:
        | MessageReceived
        | MessagePerceived
        | MessageUpdated
        | PostReceived
        | ReactionReceived
        | MembershipChanged
        | MemberJoined
        | TypingReceived
        | HistoryRead,
    ): void;
    /**
     * 看图片、动图和视频的预览帧，听语音（llm/perceive.ts）；结果作为 message.perceived 晚一点到。
     * 不给就只写"图片""动图""语音 8 秒"。
     */
    perceive?: {
      image(jpeg: Uint8Array): Promise<string>;
      gif(jpeg: Uint8Array): Promise<string>;
      video(jpeg: Uint8Array): Promise<string>;
      voice(ogg: Uint8Array): Promise<string>;
      sticker?(
        meta: { fileId?: string; fileUniqueId?: string; emoji?: string; setTitle?: string },
        load: () => Promise<Uint8Array>,
      ): Promise<string> | string;
    };
    warn?(message: string, error: unknown): void;
    /**
     * 这条消息是不是第一次进来（telegram/catch-up.ts Inbox）：推送和补拉会送来同一条，只认第一次。
     */
    admit(scope: string, messageId: string): boolean;
    /** 这个群是不是她这次启动之后才进的、还没记过（catch-up.ts Groups）。 */
    newGroup(scope: string): boolean;
    /**
     * 现场事实（telegram/scene.ts Scene）：贴纸那套的标题（查过的直接给，没查过的查到后交给 found），
     * 一条消息后来的样子里变了的那几样。不给就不记这些。
     */
    scene?: {
      stickerSet(
        set: tl.TypeInputStickerSet | null,
        found: (title: string) => void,
      ): string | undefined;
      changes(
        scope: string,
        messageId: string,
        seen: { text?: string | null; edited?: boolean; reactions?: readonly Reacted[] },
        at: number,
      ): MessageUpdated | null;
    };
  },
): { receive(msg: Message, client: Downloader): void } {
  /** 一条新消息（推送来的，或对话轮询补拉来的）。 */
  const receive = (ctx: Message, client: Downloader): void => {
    const chatId = String(ctx.chat.id);
    if (!options.admit(scopeOf(chatId), String(ctx.id))) return;
    // 她订阅的频道的新帖（P02）：不是对她说话、她也不能在里面说话，记成她看到的东西。
    if (!(ctx.chat instanceof User) && ctx.chat.chatType === "channel") {
      const facts = mediaFacts(ctx.media);
      options.onEvent({
        type: "post.received",
        at: options.now(),
        scope: scopeOf(chatId),
        messageId: String(ctx.id),
        title: ctx.chat.title,
        text: ctx.text ? ctx.text.slice(0, 4096) : null,
        ...(facts ? { media: describeMedia(facts) } : {}),
      });
      return;
    }
    const senderId = ctx.sender ? String(ctx.sender.id) : "unknown";
    const scope = scopeOf(chatId);
    // 入群提示（被拉进来、点链接进来）：别人记成谁刚进了群，她自己记成 membership.changed；都不当成一条空消息
    // 进时间线。用户账号收不到成员变化的更新（onChatMemberUpdate 线上 22 小时一次也没有），提示是主要的来源。
    const joined = joinedBy(ctx.action, senderId);
    if (joined) {
      for (const userId of joined) {
        options.onEvent(
          userId === options.selfId
            ? {
                type: "membership.changed",
                at: options.now(),
                scope,
                member: true,
                reason: ctx.action?.type === "users_added" ? "added" : "joined",
              }
            : { type: "member.joined", at: options.now(), scope, userId },
        );
      }
      return;
    }
    // 退群提示里是她自己：她退了，或被移出了。别人的退群提示照旧。
    const left = leftBy(ctx.action, senderId);
    if (left && left.userId === options.selfId) {
      options.onEvent({
        type: "membership.changed",
        at: options.now(),
        scope,
        member: false,
        reason: left.reason,
      });
      return;
    }
    // 她自己的消息由外壳在发送成功后记 message.sent。
    if (senderId === options.selfId) return;
    if (options.ignoredSenders?.has(senderId)) return;

    const replySender = ctx.replyToMessage?.sender ?? null;
    const replyToAlice =
      replySender !== null && "id" in replySender && String(replySender.id) === options.selfId;

    let mentioned = false;
    const username = options.selfUsername?.toLowerCase();
    for (const entity of ctx.entities ?? []) {
      if (username && entity.kind === "mention" && entity.text.toLowerCase() === `@${username}`) {
        mentioned = true;
        break;
      }
      if (entity.is("text_mention") && String(entity.params.userId) === options.selfId) {
        mentioned = true;
        break;
      }
    }

    const isPrivate = ctx.chat instanceof User;
    // 这次启动时对话列表里没有、Journal 里也没有过的群：她是刚被拉进来的（入群提示可能根本没送到）。
    if (!isPrivate && options.newGroup(scope)) {
      options.onEvent({
        type: "membership.changed",
        at: options.now(),
        scope,
        member: true,
        reason: "added",
      });
    }
    const replyId = ctx.replyToMessage?.id;
    const facts = mediaFacts(ctx.media);
    const sticker = ctx.media?.type === "sticker" && ctx.media.hasStickerSet ? ctx.media : null;
    const stickerSet = sticker
      ? options.scene?.stickerSet(sticker.inputStickerSet, (title) =>
          options.onEvent({
            type: "message.updated",
            at: options.now(),
            scope,
            messageId: String(ctx.id),
            stickerSet: title,
          }),
        )
      : undefined;
    const reactions = reactionsOf(ctx);
    options.onEvent({
      type: "message.received",
      at: options.now(),
      scope: scopeOf(chatId),
      chatType: isPrivate ? "private" : "group",
      messageId: String(ctx.id),
      senderId,
      senderName: ctx.sender?.displayName ?? senderId,
      text: ctx.text ? ctx.text.slice(0, 4096) : null,
      contentType: facts?.type ?? "text",
      ...(facts ? { media: describeMedia(facts) } : {}),
      replyToMessageId: replyId == null ? null : String(replyId),
      directed: isPrivate || replyToAlice || mentioned,
      ...(ctx.chat instanceof User || !ctx.chat.title ? {} : { chatTitle: ctx.chat.title }),
      ...(ctx.sender instanceof User && ctx.sender.isBot ? { isBot: true as const } : {}),
      ...(ctx.forward ? { forwardedFrom: ctx.forward.sender.displayName } : {}),
      ...(stickerSet ? { stickerSet } : {}),
      ...(editedOf(ctx) ? { edited: true as const } : {}),
      ...(reactions.length ? { reactions } : {}),
    });

    const media = ctx.media;
    const perceive = options.perceive;
    const frame = previewFrame(media);
    const look =
      !perceive || !facts
        ? null
        : media?.type === "photo"
          ? { file: media, ask: perceive.image, label: (t: string) => `图片：${t}` }
          : frame
            ? {
                file: frame,
                ask: media?.type === "video" && media.isAnimation ? perceive.gif : perceive.video,
                label: (t: string) => `${describeMedia(facts)}：${t}`,
              }
            : media?.type === "voice" && media.duration <= VOICE_MAX_SECONDS
              ? {
                  file: media,
                  ask: perceive.voice,
                  label: (t: string) => `${describeMedia(facts)}：“${t}”`,
                }
              : media?.type === "sticker" && perceive.sticker
                ? (() => {
                    const stickerAsk = perceive.sticker;
                    const sFrame = stickerFrame(media);
                    if (!sFrame || !stickerAsk) return null;
                    const meta = {
                      ...(media.fileId ? { fileId: media.fileId } : {}),
                      ...(media.uniqueFileId ? { fileUniqueId: media.uniqueFileId } : {}),
                      ...(media.emoji ? { emoji: media.emoji } : {}),
                      ...(stickerSet ? { setTitle: stickerSet } : {}),
                    };
                    void Promise.resolve()
                      .then(() => stickerAsk(meta, () => client.downloadAsBuffer(sFrame)))
                      .then((text) =>
                        options.onEvent({
                          type: "message.perceived",
                          at: options.now(),
                          scope: scopeOf(chatId),
                          messageId: String(ctx.id),
                          media: text,
                        }),
                      )
                      .catch((error) => {
                        if (!(error instanceof Failed)) options.warn?.("Perception failed", error);
                      });
                    return null;
                  })()
                : null;
    if (look) {
      void client
        .downloadAsBuffer(look.file)
        .then((bytes) => look.ask(bytes))
        .then((text) =>
          options.onEvent({
            type: "message.perceived",
            at: options.now(),
            scope: scopeOf(chatId),
            messageId: String(ctx.id),
            media: look.label(text),
          }),
        )
        // 带类型的失败（暂停时不看）是有意没做，不是出错。
        .catch((error) => {
          if (!(error instanceof Failed)) options.warn?.("Perception failed", error);
        });
    }
  };

  dispatcher.onNewMessage(async (ctx) => receive(ctx, ctx.client));

  // 别人改了消息，或表情合计变了（超级群里点表情也会来一次带 hideEditMark 的编辑）：只记变了的那几样。
  const scene = options.scene;
  if (scene)
    dispatcher.onEditMessage(async (ctx) => {
      if (!ctx.sender) return;
      if (!(ctx.chat instanceof User) && ctx.chat.chatType === "channel") return;
      const senderId = String(ctx.sender.id);
      if (senderId === options.selfId || options.ignoredSenders?.has(senderId)) return;
      const update = scene.changes(
        scopeOf(String(ctx.chat.id)),
        String(ctx.id),
        {
          text: ctx.text ? ctx.text.slice(0, 4096) : null,
          edited: editedOf(ctx),
          reactions: reactionsOf(ctx),
        },
        options.now(),
      );
      if (update) options.onEvent(update);
    });

  // 表情回应：userbot 收到的是 updateMessageReactions，mtcute 不解析，只能接原始更新。
  // 它只给聚合结果和"最近点的人"，取未读的那条作为触发者（2 月 telegram/events.ts 同样做法）。
  dispatcher.onRawUpdate(
    (_, upd) => upd._ === "updateMessageReactions",
    async (_client, upd) => {
      const raw = upd as tl.RawUpdateMessageReactions;
      const counted = options.scene?.changes(
        scopeOf(String(getMarkedPeerId(raw.peer))),
        String(raw.msgId),
        { reactions: reactedOf(raw.reactions.results) },
        options.now(),
      );
      if (counted) options.onEvent(counted);
      const recent = raw.reactions.recentReactions ?? [];
      const trigger = recent.find((r) => r.unread) ?? recent[0];
      const senderId = trigger ? String(getMarkedPeerId(trigger.peerId)) : null;
      if (senderId === options.selfId) return;
      const reaction = trigger?.reaction ?? raw.reactions.results[0]?.reaction;
      if (!reaction || reaction._ !== "reactionEmoji") return;
      options.onEvent({
        type: "reaction.received",
        at: options.now(),
        scope: scopeOf(String(getMarkedPeerId(raw.peer))),
        messageId: String(raw.msgId),
        senderId,
        emoji: reaction.emoticon,
      });
    },
  );

  // 她自己的成员身份：被踢、离开、被拉进群。别人的进出不是她的事件。
  dispatcher.onChatMemberUpdate(async (ctx) => {
    if (String(ctx.user.id) !== options.selfId) return;
    const reason = ctx.type;
    if (reason !== "kicked" && reason !== "left" && reason !== "added" && reason !== "joined")
      return;
    options.onEvent({
      type: "membership.changed",
      at: options.now(),
      scope: scopeOf(String(ctx.chat.id)),
      member: reason === "added" || reason === "joined",
      reason,
    });
  });

  // 对方正在输入 / 录语音（P06）：按 (scope, senderId) 节流 4 秒，避免刷爆 Journal；cancel 照常转发。
  const TYPING_THROTTLE_MS = 4_000;
  const lastTypingAt = new Map<string, number>();
  if (typeof dispatcher.onUserTyping === "function")
    dispatcher.onUserTyping(async (ctx) => {
      if (ctx.chatType === "channel") return;
      const senderId = String(ctx.userId);
      if (senderId === options.selfId || options.ignoredSenders?.has(senderId)) return;
      const status =
        ctx.status === "typing"
          ? "typing"
          : ctx.status === "record_voice" || ctx.status === "record_round"
            ? "voice"
            : ctx.status === "cancel"
              ? "cancel"
              : null;
      if (!status) return;
      const scope = scopeOf(String(ctx.chatId));
      const at = options.now();
      if (status !== "cancel") {
        const key = `${scope}:${senderId}`;
        if (at - (lastTypingAt.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
        lastTypingAt.set(key, at);
      }
      options.onEvent({
        type: "typing.received",
        at,
        scope,
        chatType: ctx.chatType === "user" ? "private" : "group",
        senderId,
        status,
      });
    });

  // 会话已读回执（P06）：跳过频道讨论串和 monoforum，只在同一方向水位前进时记录。
  const lastReadWatermark = new Map<string, number>();
  if (typeof dispatcher.onHistoryRead === "function")
    dispatcher.onHistoryRead(async (ctx) => {
      if (ctx.isDiscussion || ctx.isMonoForum) return;
      const scope = scopeOf(String(ctx.chatId));
      const key = `${scope}:${ctx.isOutbox ? "out" : "in"}`;
      if (ctx.maxReadId <= (lastReadWatermark.get(key) ?? 0)) return;
      lastReadWatermark.set(key, ctx.maxReadId);
      options.onEvent({
        type: "history.read",
        at: options.now(),
        scope,
        chatType: ctx.chatId > 0 ? "private" : "group",
        outbox: ctx.isOutbox,
        maxReadId: String(ctx.maxReadId),
        unreadCount: ctx.unreadCount,
      });
    });

  return { receive };
}
