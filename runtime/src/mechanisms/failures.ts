/**
 * 她想做没做成的对外动作（表情没点上、贴纸没发出去、消息被拒）：在那个会话里作为事实告诉她。
 * 外壳把失败记成 act.failed（带 telegram/errors 的错误码），以前只进日志，她不知道自己那条没发出去。
 * 来源：8 月 impulse.pending（失败的动作下次唤醒时注入"你上次想做但没完成"，5 分钟过期）、
 * 2 月 PendingImpulse（最多 3 条）。这里只取事实那一半：说清楚没做成和原因，不说"再试一次"，
 * 也不叫醒她；要不要再做由她下一次自己决定（失败从不自动重做，capabilities.md M23）。
 * 交出去办的事（delegate）没办成由 step() 自己告诉她，这里不管。
 */
import { type Act, affordanceOf } from "../mind/affordances.js";
import type { AliceEvent } from "../mind/events.js";
import { type Failure as FailureReason, failureIn, failureText } from "../mind/failure.js";
import { type Contribution, defineMechanism } from "../mind/mechanism.js";
import { SEND_LIMIT } from "../mind/state.js";

/**
 * 失败之后在那个会话里留多久：10 分钟，和看过的东西留在提示词里的时长（LOOKED_MS）、一段连续往来的间隔
 * （closeness 的 EPISODE_GAP_MS）一样，是"刚才"的尺度。比 8 月的 5 分钟长：那是要不要接着做的冲动，
 * 这里是世界的事实，对方隔几分钟问"你发了啥"时她还该知道。她在那里又发出一条消息，就不再写。
 */
export const FAILED_SHOWN_MS = 10 * 60_000;
/** 同一个会话最多记几件（2 月 IMPULSE_MAX_COUNT）。 */
const KEPT = 3;
const SNIPPET = 16;

interface Failure {
  at: number;
  act: Act;
  failure: FailureReason;
  /** 同一次决定里因为它而没做的后续动作。 */
  skipped: number;
}

export type FailuresState = Readonly<Record<string, readonly Failure[]>>;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET)}…` : flat;
}

/** 她想做的事和"做成了"怎么说。 */
function attempted(act: Act): { what: string; done: string } | null {
  switch (act.kind) {
    case "send":
      return { what: `我刚才想发的「${snippet(act.text)}」`, done: "发出去" };
    case "sticker":
      return { what: `我刚才想发的「${act.word}」贴纸`, done: "发出去" };
    case "react":
      return { what: `我刚才想给 [${act.messageId}] 点的表情 ${act.emoji} `, done: "点上" };
    case "album-send":
      return { what: `我刚才想发的相册里的图 ${act.asset}`, done: "发出去" };
    case "album-search":
      return { what: `我刚才想翻相册找「${snippet(act.query)}」`, done: "翻成" };
    case "mark-read":
      return { what: "我刚才想把这里标成已读", done: "标上" };
    case "leave-chat":
      return { what: "我刚才想退出这里", done: "退成" };
    case "join-chat":
      return { what: "我刚才想加入这里", done: "加进来" };
    case "forward":
      return { what: `我刚才想转发的 ${act.item}`, done: "转过来" };
    case "chat-search":
      return { what: `我刚才想找「${snippet(act.query)}」的群`, done: "找成" };
    case "voice":
      return { what: `我刚才想用语音说的「${snippet(act.text)}」`, done: "发出去" };
    case "edit":
      return { what: `我刚才想把 [${act.messageId}] 改成「${snippet(act.text)}」`, done: "改成" };
    case "repeat":
      return { what: `我刚才想跟着复读的 [${act.messageId}] `, done: "发出去" };
    default:
      return null;
  }
}

function sentence(f: Failure): string | null {
  const a = attempted(f.act);
  if (!a) return null;
  // 结果未知另写；其余用失败码表里她的话说原因。
  const head =
    f.failure.reason === "outcome_unknown"
      ? `${a.what}不知道${a.done}没有`
      : `${a.what}没${a.done}（${failureText(f.failure)}）`;
  return `${head}${f.skipped > 0 ? "，那一回后面的也都没做" : ""}。`;
}

/**
 * 没发出去的：她在一次决定里想连着说好几句，超过一分钟 SEND_LIMIT 条的上限，后面几条落成动作时被丢掉
 * （settle.ts）。和失败一样是事实，不说"再试一次"。
 */
function droppedSentence(act: Act): string | null {
  const a = attempted(act);
  return a ? `${a.what}没发出去（一分钟内最多连发 ${SEND_LIMIT} 条）。` : null;
}

const same = (a: Act, b: Act) => JSON.stringify(a) === JSON.stringify(b);

export function reduceFailures(state: FailuresState, event: AliceEvent): FailuresState {
  if (event.type === "message.sent") {
    if (!(event.scope in state)) return state;
    const { [event.scope]: _spoken, ...rest } = state;
    return rest;
  }
  if (event.type !== "act.failed" || affordanceOf(event.act.kind).via !== "telegram") {
    return state;
  }
  const kept = (state[event.scope] ?? []).filter((f) => event.at - f.at <= FAILED_SHOWN_MS);
  if (event.reason === "skipped_after_failure") {
    const last = kept.at(-1);
    if (!last) return state;
    return {
      ...state,
      [event.scope]: [...kept.slice(0, -1), { ...last, skipped: last.skipped + 1 }],
    };
  }
  const failure: Failure = { at: event.at, act: event.act, failure: failureIn(event), skipped: 0 };
  const next = [...kept.filter((f) => !same(f.act, event.act)), failure].slice(-KEPT);
  return { ...state, [event.scope]: next };
}

export const failures = defineMechanism<FailuresState>({
  name: "failures",
  initial: {},
  reduce: reduceFailures,
  contribute(chat, now, state): Contribution[] {
    const failed = (state[chat.scope] ?? [])
      .filter((f) => now - f.at <= FAILED_SHOWN_MS)
      .flatMap((f) => {
        const text = sentence(f);
        return text ? [{ mechanism: "failures", kind: "failed" as const, text }] : [];
      });
    const dropped = (chat.droppedSends ?? [])
      .filter((d) => now - d.at <= FAILED_SHOWN_MS)
      .flatMap((d) => {
        const text = droppedSentence(d.act);
        return text ? [{ mechanism: "failures", kind: "failed" as const, text }] : [];
      });
    return [...failed, ...dropped];
  },
});
