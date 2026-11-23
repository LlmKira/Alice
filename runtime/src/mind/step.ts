import {
  type Act,
  affordanceOf,
  argOf,
  availableKinds,
  leaves,
  type PostKind,
} from "./affordances.js";
import { chatView } from "./chat-view.js";
import {
  type Effect,
  type LogItem,
  ponderTarget,
  SELF_SCOPE,
  type SpeechRequest,
} from "./effects.js";
import type {
  ActDone,
  AliceEvent,
  ClockTick,
  MessageReceived,
  MessageSent,
  SpeechDecision,
} from "./events.js";
import { failureText } from "./failure.js";
import { type Mechanism, type PonderAsk, WAKE_THRESHOLD } from "./mechanism.js";
import { foldedOf, type Mind, mechanismsIn, switchArm } from "./rotation.js";
import { settleDecision } from "./settle.js";
import {
  type AliceState,
  type ChatState,
  DROPPED_KEPT,
  DROPPED_MS,
  emptyChat,
  emptyState,
  LOOK_RUN_LIMIT,
  LOOKED_KEPT,
  LOOKED_MS,
  type Looked,
  PATIENCE_CAP_MS,
  SEGMENT_GAP_MS,
  SEGMENTS_KEPT,
  SENT_IDS_KEPT,
  TIMELINE_LIMIT,
  type TimelineEntry,
} from "./state.js";

export interface StepResult {
  state: AliceState;
  effects: Effect[];
}

/**
 * Alice 唯一的状态转换。纯函数：不读时钟、不读库、不发请求；时间只来自 event.at。
 * 所有对外动作都以 Effect 返回，由外壳执行，执行结果再作为事件送回来。
 * mind 是一套机制，或者生产和候选两套轮换（rotation.ts）：两套都 fold 每个事件，每个会话里的决定用它眼下那一组。
 */
export function step(previous: AliceState, received: AliceEvent, mind: Mind): StepResult {
  const event = towardHer(previous, received);
  // 换组只是一条记录，不是她经历的事：机制不 fold 它。
  if (event.type === "arm.switched") return { state: switchArm(previous, event), effects: [] };
  const state = foldMechanisms(previous, event, foldedOf(mind));
  const mechanisms = mechanismsIn(mind, state, "scope" in event ? event.scope : null);
  switch (event.type) {
    case "message.received":
      return onMessage(state, event, mechanisms);
    case "message.sent":
      return onSent(state, event);
    case "message.perceived":
      return onPerceived(state, event);
    case "speech.decided":
      return onDecision(state, event.scope, event.callId, event.at, event.decision, mechanisms);
    case "speech.failed":
      return onSpeechFailed(state, event);
    case "ponder.done":
    case "ponder.failed":
      // 结果（不论成败）已经由各机制的 reduce fold 进去了；这里只结束这次想一想。失败不重试。
      return state.pondering?.callId === event.callId
        ? { state: { ...state, pondering: null }, effects: [] }
        : { state, effects: [] };
    case "timer.fired":
      return onTimer(state, event, mechanisms);
    case "act.started": {
      const chat = state.chats[event.scope];
      if (!chat) return { state, effects: [] };
      const running = [...chat.running, { at: event.at, act: event.act }];
      return { state: put(state, { ...chat, running }), effects: [] };
    }
    case "act.done":
      return onDone(state, event, mechanisms);
    case "act.failed":
      return onActFailed(state, event, mechanisms);
    case "reaction.received":
    // 频道的新帖只是她看得到的东西（压力场 fold 它），不进会话、不叫醒她。
    case "post.received":
    // 消息后来的样子（改过、表情合计、贴纸那套）、群的样子与已读回执只 fold 进机制，不叫醒她。
    case "message.updated":
    case "chat.described":
    case "history.read":
      return { state, effects: [] };
    case "typing.received":
      return onTyping(state, event, mechanisms);
    case "membership.changed": {
      const chat = state.chats[event.scope];
      if (!chat || chat.member === event.member) return { state, effects: [] };
      return { state: put(state, { ...chat, member: event.member }), effects: [] };
    }
    case "clock.tick":
      return onTick(state, event, mind);
    case "noise.drawn":
      // 随机数只经各机制的 reduce fold 进它们自己的状态；它本身不叫醒谁，下一个时钟格才看得出变化。
      return { state, effects: [] };
    case "member.joined":
      // 别人进群只 fold 进机制的状态（谁是刚来的），不叫醒她。
      return { state, effects: [] };
  }
}

type EventOf<T extends AliceEvent["type"]> = Extract<AliceEvent, { type: T }>;

function onSent(state: AliceState, event: MessageSent): StepResult {
  const chat = state.chats[event.scope];
  if (!chat) return { state, effects: [] };
  const sentIds = [...chat.sentIds, event.messageId].slice(-SENT_IDS_KEPT);
  return {
    state: put(state, {
      ...chat,
      ...appendTo(chat, sentEntry(event)),
      sentIds,
      // 她在这里真的说出去了：刚才没发出去的那几条不再是"此刻的事实"。
      droppedSends: [],
    }),
    effects: [],
  };
}

/** 感知带着 media 时写回时间线上别人发的那一条；只有口气的感知不改时间线（机制各自 fold 它）。 */
function onPerceived(state: AliceState, event: EventOf<"message.perceived">): StepResult {
  const chat = state.chats[event.scope];
  const media = event.media;
  if (
    media === undefined ||
    !chat?.timeline.some((e) => e.messageId === event.messageId && e.sender !== null)
  ) {
    return { state, effects: [] };
  }
  const timeline = chat.timeline.map((e) =>
    e.messageId === event.messageId && e.sender ? { ...e, media } : e,
  );
  return { state: put(state, { ...chat, timeline }), effects: [] };
}

function onSpeechFailed(state: AliceState, event: EventOf<"speech.failed">): StepResult {
  const chat = state.chats[event.scope];
  if (!chat || chat.mind.mode !== "deciding" || chat.mind.callId !== event.callId) {
    return { state, effects: [] };
  }
  // 失败不自动重试：重试由发言层在一次调用内部完成，这里再起调用会形成循环。
  return { state: put(state, { ...chat, mind: { mode: "idle" } }), effects: [] };
}

/** 等对方说完的时间到了：叫醒她的理由此刻还成立就开口，否则回到空闲。 */
function onTimer(
  state: AliceState,
  event: EventOf<"timer.fired">,
  mechanisms: readonly Mechanism[],
): StepResult {
  const chat = state.chats[event.scope];
  if (!chat || chat.mind.mode !== "waiting" || chat.mind.timerId !== event.timerId) {
    return { state, effects: [] };
  }
  if (!stillWakes(state, chat, chat.mind.waking, event.at, mechanisms)) {
    return { state: put(state, { ...chat, mind: { mode: "idle" } }), effects: [] };
  }
  return startCall(state, chat, event.at, chat.mind.triggerMessageId, mechanisms);
}

/** 交出去的事没办成：她也会知道（和办成一样回到这个会话、叫醒她）；其他动作失败不改状态。 */
function onActFailed(
  state: AliceState,
  event: EventOf<"act.failed">,
  mechanisms: readonly Mechanism[],
): StepResult {
  const chat = state.chats[event.scope];
  const row = affordanceOf(event.act.kind);
  if (!chat || row.via !== "errand") return { state, effects: [] };
  const seen = {
    at: event.at,
    kind: event.act.kind,
    text: `${row.after.as}，没结果（${failureText(event)}）`,
  };
  return onLooked(state, finished(chat, event.act), seen, mechanisms, Boolean(event.inline));
}

/** 等着时对方在输入：各机制给的耐心里最长的那一段，比原来等到的更晚就延后（不超过上限）。 */
function onTyping(
  state: AliceState,
  event: EventOf<"typing.received">,
  mechanisms: readonly Mechanism[],
): StepResult {
  const chat = state.chats[event.scope];
  if (!chat || chat.mind.mode !== "waiting" || event.status === "cancel") {
    return { state, effects: [] };
  }
  const extra = Math.max(
    0,
    ...mechanisms.map((m) => m.patience?.(chat, event, event.at, mechanismState(state, m)) ?? 0),
  );
  if (extra <= 0) return { state, effects: [] };
  const currentUntil =
    Number(chat.mind.timerId.split("~").at(-1)) || chat.mind.since + chat.mind.wait;
  const until = Math.min(event.at + extra, chat.mind.since + PATIENCE_CAP_MS);
  if (until <= currentUntil) return { state, effects: [] };
  return startWaiting(state, chat, chat.mind.since, chat.mind.wait, until, chat.mind.waking);
}

/** 这条消息回复的是她发过的某一条（编号在会话状态里，sentIds）。 */
function repliesToHer(state: AliceState, event: AliceEvent): boolean {
  if (event.type !== "message.received" || event.replyToMessageId === null) return false;
  return state.chats[event.scope]?.sentIds.includes(event.replyToMessageId) ?? false;
}

/**
 * 一条消息是不是冲着她的，只在这里定。Journal 记的是事实（私聊、点名，平台说了被回复的是她）；回复她发过的
 * 某一条，就是在找她，和点名一样算 directed。所以外壳认不出的回复也算，以前的 Journal 回放也一样。
 * 平台标了 isBot 的账号不算冲着她说话。读 Journal 的工具没有心智状态时用 towardHerReader。
 */
export function towardHer(state: AliceState, event: AliceEvent): AliceEvent {
  if (event.type !== "message.received") return event;
  if (event.isBot === true) return event.directed ? { ...event, directed: false } : event;
  if (event.directed || !repliesToHer(state, event)) return event;
  return { ...event, directed: true };
}

/**
 * 给只读 Journal 的工具（北极星）：按日志顺序送进每个事件，得到心智眼里的那个事件，和它是不是回复她的。
 * 只 fold 会话（不带机制），所以和心智用的是同一份编号、同一个判断。
 */
export function towardHerReader(): (event: AliceEvent) => { event: AliceEvent; reply: boolean } {
  let state: AliceState = emptyState;
  return (logged) => {
    const reply = repliesToHer(state, logged);
    const event = towardHer(state, logged);
    state = step(state, event, []).state;
    return { event, reply };
  };
}

/** 等到 at 之后的安静再开口；对方继续说话时由 onMessage 重新计时。 */
function startWaiting(
  state: AliceState,
  chat: ChatState,
  since: number,
  wait: number,
  until: number,
  waking: MessageReceived | null,
): StepResult {
  const timerId = `${chat.scope}~${until}`;
  const triggerMessageId = waking?.messageId ?? null;
  return {
    state: put(state, {
      ...chat,
      mind: { mode: "waiting", since, wait, timerId, triggerMessageId, waking },
    }),
    effects: [{ type: "set-timer", scope: chat.scope, timerId, at: until }],
  };
}

function onMessage(
  state: AliceState,
  event: MessageReceived,
  mechanisms: readonly Mechanism[],
): StepResult {
  const base = state.chats[event.scope] ?? emptyChat(event.scope, event.chatType, true);
  // 能收到会话里的消息，说明她在里面。
  const chat: ChatState = {
    ...base,
    member: true,
    ...appendTo(base, {
      at: event.at,
      messageId: event.messageId,
      sender: {
        id: event.senderId,
        name: event.senderName,
        ...(event.isBot ? { isBot: true as const } : {}),
      },
      text: event.text,
      contentType: event.contentType,
      ...(event.media ? { media: event.media } : {}),
      replyToMessageId: event.replyToMessageId,
      ...(event.directed ? { directed: true as const } : {}),
    }),
    // 别人又说话了：这是新的一段，连续操作的计数从头算。
    lookRun: 0,
  };
  const mind = chat.mind;
  // 正在等对方说完：会话里又有人说话，就从这条起重新计时（不超过上限）。
  if (mind.mode === "waiting") {
    const until = Math.min(event.at + mind.wait, mind.since + PATIENCE_CAP_MS);
    const waking = wakesOn(state, chat, event, mechanisms) ? event : mind.waking;
    return startWaiting(state, chat, mind.since, mind.wait, until, waking);
  }
  if (!wakesOn(state, chat, event, mechanisms)) return { state: put(state, chat), effects: [] };
  if (mind.mode === "deciding") {
    return {
      state: put(state, { ...chat, mind: { ...mind, wakeAgain: true, waking: event } }),
      effects: [],
    };
  }
  const wait = Math.max(
    0,
    ...mechanisms.map((m) => m.patience?.(chat, event, event.at, mechanismState(state, m)) ?? 0),
  );
  if (wait > 0) {
    return startWaiting(state, chat, event.at, wait, event.at + wait, event);
  }
  return startCall(state, chat, event.at, event.messageId, mechanisms);
}

/**
 * 时钟走了一格：没有新消息，但随时间变化的机制（比如压力随沉默增长）可能想醒。
 * 按会话依次问一遍，只叫醒空闲的会话；没有消息可等，所以不经 patience，直接开口。
 */
function onTick(state: AliceState, event: ClockTick, mind: Mind): StepResult {
  // 她自己的事（开新会话、扫一眼、想一想）用她的那一组；每个会话里的叫醒用那个会话的。
  const self = mechanismsIn(mind, state, null);
  let next = openWanted(state, event.at, self);
  const effects: Effect[] = [];
  // 她在看手机（Mechanism.scans）：时钟格没叫醒的会话里，有别人新说的话的，拿最新那条再问一次。
  const scanning = self.some((m) => m.scans?.(event.at, mechanismState(state, m)) ?? false);
  for (const chat of Object.values(next.chats)) {
    if (chat.mind.mode !== "idle") continue;
    const r = tickChat(state, next, chat, event, mechanismsIn(mind, state, chat.scope), scanning);
    next = r.state;
    effects.push(...r.effects);
  }
  const pondered = withPonder(next, event.at, self);
  return { state: pondered.state, effects: [...effects, ...pondered.effects] };
}

/** 她想去的、还没有的会话（没开过的私聊、只看过预览的群）：先建成空会话，之后照常问要不要醒。 */
function openWanted(state: AliceState, at: number, self: readonly Mechanism[]): AliceState {
  let next = state;
  for (const m of self) {
    const o = m.opens?.(at, mechanismState(state, m));
    if (o && !next.chats[o.scope]) next = put(next, emptyChat(o.scope, o.chatType, o.member));
  }
  return next;
}

/**
 * 时钟格问一个空闲的会话：要醒就开口；不醒但她在看手机（scanning），按别人最新说的那条再问一次。state 是这一格各机制的状态，next 是已经叫醒了前面几个会话的状态。
 */
function tickChat(
  state: AliceState,
  next: AliceState,
  chat: ChatState,
  event: ClockTick,
  mechanisms: readonly Mechanism[],
  scanning: boolean,
): StepResult {
  if (wakesOn(state, chat, event, mechanisms)) {
    return startCall(next, chat, event.at, null, mechanisms);
  }
  const unseen = scanning ? newest(chat) : null;
  if (unseen && stillWakes(state, chat, unseen, event.at, mechanisms)) {
    return startCall(next, chat, event.at, unseen.messageId, mechanisms);
  }
  return { state: next, effects: [] };
}

/** 想一想：没有正在进行的，就问各机制要不要想（醒来想想自己、心情变了之后写日记；由机制决定）。 */
function withPonder(next: AliceState, at: number, self: readonly Mechanism[]): StepResult {
  if (next.pondering !== null) return { state: next, effects: [] };
  const ask = firstPonder(next, at, self);
  if (!ask) return { state: next, effects: [] };
  const callId = `${SELF_SCOPE}~${ask.kind}@${at}`;
  return {
    state: { ...next, pondering: { callId, ...ponderTarget(ask) } },
    effects: [{ type: "call-ponder", scope: SELF_SCOPE, callId, request: { ...ask, at } }],
  };
}

function firstPonder(
  state: AliceState,
  now: number,
  mechanisms: readonly Mechanism[],
): PonderAsk | null {
  for (const m of mechanisms) {
    const ask = m.ponder?.(now, mechanismState(state, m), state.chats);
    if (ask) return ask;
  }
  return null;
}

function wakesOn(
  state: AliceState,
  chat: ChatState,
  event: AliceEvent,
  mechanisms: readonly Mechanism[],
): boolean {
  return mechanisms.some(
    (m) => (m.wake?.(chat, event, event.at, mechanismState(state, m)) ?? 0) >= WAKE_THRESHOLD,
  );
}

/**
 * 推迟了的叫醒（等对方说完、想完这一次再看）真正开始想的那一刻，拿叫醒她的那条消息按此刻再问一次各机制：
 * 叫醒的理由只有在开始想时还成立才算。睡觉、离开这些处境都只在机制里，这里不认识它们；这样每一条叫醒的路
 * 都经过同一个判断，没有哪条能绕过（2026-11-13 普查：她去睡之前 6 秒群里一条话让她等着要看，等完时
 * 她已经说了晚安，照样被叫起来）。她自己办的事的结果叫醒她时没有这条消息，不再问。
 */
function stillWakes(
  state: AliceState,
  chat: ChatState,
  waking: MessageReceived | null,
  at: number,
  mechanisms: readonly Mechanism[],
): boolean {
  return waking === null || wakesOn(state, chat, { ...waking, at }, mechanisms);
}

/**
 * 她最后一次在这里说话之后别人说的，一眼看到的那一条（按收到时的样子）：有冲着她的（点名、回复她、私聊）就是
 * 其中最新的一条——平台把提到她、回复她的单独标出来，不混在未读数里；没有就是最新的一条。她自己的话
 * 是最新的一条时是 null。
 */
function newest(chat: ChatState): MessageReceived | null {
  const tail = chat.timeline.slice(chat.timeline.findLastIndex((e) => !e.sender) + 1);
  const last = tail.findLast((e) => e.directed) ?? tail.at(-1);
  if (!last?.sender) return null;
  return {
    type: "message.received",
    at: last.at,
    scope: chat.scope,
    chatType: chat.chatType,
    messageId: last.messageId,
    senderId: last.sender.id,
    senderName: last.sender.name,
    ...(last.sender.isBot ? { isBot: true as const } : {}),
    text: last.text,
    contentType: last.contentType,
    ...(last.media ? { media: last.media } : {}),
    replyToMessageId: last.replyToMessageId,
    directed: last.directed === true,
  };
}

function onDecision(
  state: AliceState,
  scope: string,
  callId: string,
  at: number,
  decision: SpeechDecision,
  mechanisms: readonly Mechanism[],
): StepResult {
  const chat = state.chats[scope];
  // 只接受本会话当前这次调用的结果：过期或别处的决定一律丢弃，所以发言不会串到别的会话。
  if (!chat || chat.mind.mode !== "deciding" || chat.mind.callId !== callId) {
    return { state, effects: [] };
  }
  const { acts, recentSends, dropped } = settleDecision(chat, decision, at);
  // 不变量：每个动作都发往做出决定的这个会话。
  const effects: Effect[] = acts.map((act) => ({ type: "act", scope: chat.scope, act }));
  // 没发出去的也记下来（过期的先扔掉）：下一次发言时她会知道自己刚才想说而没说出来的是什么。
  const droppedSends = [
    ...(chat.droppedSends ?? []).filter((d) => at - d.at <= DROPPED_MS),
    ...dropped.map((act) => ({ at, act })),
  ].slice(-DROPPED_KEPT);
  const settled: ChatState = { ...chat, recentSends, droppedSends, mind: { mode: "idle" } };
  // 决定离开这个会话时，不再为期间的唤醒另起一次调用。
  if (!chat.mind.wakeAgain || acts.some(leaves)) return { state: put(state, settled), effects };
  if (!stillWakes(state, settled, chat.mind.waking, at, mechanisms)) {
    return { state: put(state, settled), effects };
  }
  const next = startCall(state, settled, at, null, mechanisms);
  return { state: next.state, effects: [...effects, ...next.effects] };
}

/** 一个动作做完了：会话里的变化由登记表的 after 决定；没有 after 的动作不改状态。 */
function onDone(state: AliceState, event: ActDone, mechanisms: readonly Mechanism[]): StepResult {
  const chat = state.chats[event.scope];
  const after = affordanceOf(event.act.kind).after;
  if (!chat || !after) return { state, effects: [] };
  const { act } = event;
  switch (after.type) {
    case "look": {
      if (event.result === undefined) return { state, effects: [] };
      const seen = { at: event.at, kind: act.kind, text: `${after.as}：${event.result}` };
      return onLooked(state, finished(chat, act), seen, mechanisms, Boolean(event.inline));
    }
    case "annotate":
      return { state: put(state, annotate(chat, argOf(act, "message"), after.note)), effects: [] };
    case "revise": {
      const revised = revise(chat, argOf(act, "own"), argOf(act, "text"), after.note);
      return { state: put(state, revised), effects: [] };
    }
    case "remove": {
      const removed = removeEntry(chat, argOf(act, "recent"), after.note);
      return { state: put(state, removed), effects: [] };
    }
    case "member":
      return { state: put(state, { ...chat, member: after.member }), effects: [] };
  }
}

/** 她发出去的一条在时间线里的样子，按 message.sent 的 kind。 */
const SENT_AS: Record<PostKind, (text: string) => { text: string | null; media?: string }> = {
  text: (text) => ({ text }),
  // 语音也留下她说的话：她看得出自己用语音说过什么。
  voice: (text) => ({ text }),
  sticker: () => ({ text: null }),
  // 从相册发的图带上编号：她看得出已经发过哪张（探针里有一次同一张发了两遍）。
  photo: (text) => ({ text: null, media: `相册里的图 ${text}` }),
  forward: (text) => ({ text: null, media: `你转发的 ${text}` }),
};

/** 她发出去的一条在记录里的那一行（上下文组装的候选也按它记她的话）。 */
export function sentEntry(event: MessageSent): TimelineEntry {
  const shown = SENT_AS[event.kind](event.text);
  return {
    at: event.at,
    messageId: event.messageId,
    sender: null,
    text: shown.text,
    contentType: event.kind,
    ...(shown.media ? { media: shown.media } : {}),
    replyToMessageId: null,
  };
}

/** 给动作指向的那条消息加注；那条已经不在记录里就什么也不做。 */
function annotate(chat: ChatState, id: string | null, note: string): ChatState {
  if (!id || !chat.timeline.some((e) => e.messageId === id)) return chat;
  return { ...chat, timeline: chat.timeline.map((e) => (e.messageId === id ? { ...e, note } : e)) };
}

/**
 * 她改了自己的一条消息：记录里那一行换成新的话（她和别人此后看到的都是改过的），带上注。
 * 那条已经不在记录里就什么也不做。是不是她自己刚发的，落成动作时（参数种类 own）已经查过。
 */
function revise(chat: ChatState, id: string | null, text: string | null, note: string): ChatState {
  if (!id || !text) return chat;
  return {
    ...chat,
    timeline: chat.timeline.map((e) => (e.messageId === id ? { ...e, text, note } : e)),
  };
}

/** 她撤回了自己的一条消息：记录里那一行清空原话、带上注，不再当成可编辑/可撤回的发言。 */
function removeEntry(chat: ChatState, id: string | null, note: string): ChatState {
  if (!id || !chat.timeline.some((e) => e.messageId === id)) return chat;
  return {
    ...chat,
    timeline: chat.timeline.map((e) => (e.messageId === id ? { ...e, text: null, note } : e)),
  };
}

/** 交出去的那件事办完了（成或不成）：从"还没好"里删掉。内容相同的只删最早的一件。 */
function finished(chat: ChatState, act: Act): ChatState {
  const { running } = chat;
  const i = running.findIndex((r) => JSON.stringify(r.act) === JSON.stringify(act));
  if (i < 0) return chat;
  return { ...chat, running: [...running.slice(0, i), ...running.slice(i + 1)] };
}

/**
 * 看了结果（翻相册、查一下）：记进这个会话"刚看过的"，再叫醒她一次，让她看了再决定下一步
 * （发图、换个说法再找、或者不发）。正在想的时候先记着，想完再醒（wakeAgain）。
 * 连着醒的次数有上限，免得看一次、再看一次地停不下来；别人说话就重新计数。
 */
function onLooked(
  state: AliceState,
  chat: ChatState,
  look: Looked,
  mechanisms: readonly Mechanism[],
  inline = false,
): StepResult {
  const at = look.at;
  const run = chat.lookRun;
  const seen: ChatState = { ...chat, looked: [...chat.looked, look].slice(-LOOKED_KEPT) };
  // 交出去办的事的结果总会叫醒她：那是她托人办、在等的事；每个会话一次只办一件，不会停不下来。
  const awaited = affordanceOf(look.kind).via === "errand";
  if (inline) {
    return { state: put(state, { ...seen, lookRun: run + 1 }), effects: [] };
  }
  if ((run >= LOOK_RUN_LIMIT && !awaited) || !seen.member) {
    return { state: put(state, seen), effects: [] };
  }
  const next: ChatState = { ...seen, lookRun: run + 1 };
  if (next.mind.mode === "deciding") {
    return { state: put(state, { ...next, mind: { ...next.mind, wakeAgain: true } }), effects: [] };
  }
  if (next.mind.mode !== "idle") return { state: put(state, next), effects: [] };
  return startCall(state, next, at, null, mechanisms);
}

function startCall(
  state: AliceState,
  chat: ChatState,
  at: number,
  triggerMessageId: string | null,
  mechanisms: readonly Mechanism[],
): StepResult {
  const callId = `${chat.scope}#${chat.calls + 1}`;
  const deciding: ChatState = {
    ...chat,
    calls: chat.calls + 1,
    mind: { mode: "deciding", callId, since: at, wakeAgain: false, waking: null },
  };
  return {
    state: put(state, deciding),
    effects: [
      {
        type: "call-speech",
        scope: chat.scope,
        callId,
        request: speechRequest(state, deciding, at, triggerMessageId, mechanisms),
      },
    ],
  };
}

/** 一次发言调用看到的全部内容：会话时间线加各机制的贡献。基准回放也走这里。 */
export function speechRequest(
  state: AliceState,
  chat: ChatState,
  at: number,
  triggerMessageId: string | null,
  mechanisms: readonly Mechanism[],
): SpeechRequest {
  const looked = chat.looked.filter((l) => at - l.at <= LOOKED_MS);
  const withheld = new Set(
    mechanisms.flatMap((m) => m.withholds?.(chat, at, mechanismState(state, m)) ?? []),
  );
  const affordances = availableKinds(
    chatView(chat),
    at,
    new Set(
      mechanisms.flatMap(
        (m) => m.affordancesIn?.(chat.scope, mechanismState(state, m), at) ?? m.affordances ?? [],
      ),
    ),
  ).filter((k) => !withheld.has(k));
  let log: LogItem[] | null = null;
  for (const m of mechanisms) {
    log ??= m.layout?.(chat, at, mechanismState(state, m), triggerMessageId) ?? null;
  }
  return {
    ...(looked.length > 0 ? { looked } : {}),
    ...(chat.running.length ? { running: chat.running } : {}),
    ...(chat.earlier.length ? { earlier: chat.earlier } : {}),
    ...(log ? { log } : {}),
    scope: chat.scope,
    chatType: chat.chatType,
    timeline: chat.timeline,
    contributions: mechanisms.flatMap(
      (m) => m.contribute?.(chat, at, mechanismState(state, m), affordances) ?? [],
    ),
    triggerMessageId,
    at,
    affordances,
  };
}

function foldMechanisms(
  state: AliceState,
  event: AliceEvent,
  mechanisms: readonly Mechanism[],
): AliceState {
  let next: Record<string, unknown> | null = null;
  for (const m of mechanisms) {
    if (!m.reduce) continue;
    next ??= { ...state.mechanisms };
    next[m.name] = m.reduce(mechanismState(state, m), event);
  }
  return next ? { ...state, mechanisms: next } : state;
}

function mechanismState(state: AliceState, m: Mechanism): unknown {
  return m.name in state.mechanisms ? state.mechanisms[m.name] : m.initial;
}

/** 加一条进时间线；从前面挤出去的 fold 进"更早的聊天"分段。 */
function appendTo(chat: ChatState, entry: TimelineEntry): Pick<ChatState, "timeline" | "earlier"> {
  const all = [...chat.timeline, entry];
  const timeline = all.slice(-TIMELINE_LIMIT);
  const dropped = all.slice(0, all.length - timeline.length);
  if (dropped.length === 0) return { timeline, earlier: chat.earlier };
  const earlier = [...chat.earlier];
  for (const e of dropped) {
    const last = earlier.at(-1);
    if (last && e.at - last.to <= SEGMENT_GAP_MS) {
      earlier[earlier.length - 1] = { ...last, to: e.at, count: last.count + 1, last: e };
    } else {
      earlier.push({ from: e.at, to: e.at, count: 1, first: e, last: e });
    }
  }
  return { timeline, earlier: earlier.slice(-SEGMENTS_KEPT) };
}

function put(state: AliceState, chat: ChatState): AliceState {
  return { ...state, chats: { ...state.chats, [chat.scope]: chat } };
}
