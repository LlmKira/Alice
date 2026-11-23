/**
 * 跨多天、跨多会话的时空连贯与内生生命感审计（PLAN 第 58 件 / north-star.md「还没有读数的地方」）。
 * 不调模型、纯统计与不变量检查：从一段连续多天的闭环日志（events + calls）里量出：
 * 1. 睡眠期 dream / 日程表生成次数与 life-leak（日程里绝不能出现真实群友名字）；
 * 2. 内生好奇点（self:dream） vs 外部频道新帖带来的唤醒与开口次数；
 * 3. PTC 自管长期连贯动作（recall、note-self、open/advance/close topic、intend/fulfil）；
 * 4. 多群之间的正负回流分化（不同群接她比例与她活跃度分化）；
 * 5. 长程一致性风险提示（比如同一批人/自述被反复推翻或跨群隐私异常）。
 */
import type { AliceEvent } from "../mind/events.js";

export interface LongAuditReport {
  days: number;
  lifeDays: number;
  dreamDays: number;
  lifeLeaks: string[];
  curiositiesGenerated: number;
  dreamSharesShown: number;
  channelSharesShown: number;
  topicOpens: number;
  topicAdvances: number;
  topicCloses: number;
  intends: number;
  fulfils: number;
  recalls: number;
  selfNotes: number;
  selfReplacements: number;
  /** 各群发言调用与收到消息之比（用来检查多群是否随反馈分化而不是均质平摊）。 */
  groupRates: ReadonlyArray<{ scope: string; received: number; calls: number; ratePer100: number }>;
}

export interface LongAuditCall {
  scope: string;
  at: number;
  kind?: string;
  acts?: ReadonlyArray<{ kind: string; text?: string; replaces?: string | null }>;
  causes?: readonly string[];
}

export function auditLongRun(
  events: readonly AliceEvent[],
  calls: readonly LongAuditCall[] = [],
): LongAuditReport {
  const times = events.map((e) => e.at).filter((t) => Number.isFinite(t));
  // 不用 Math.max(...times)：十几万个参数会撑爆调用栈。
  const spanMs =
    times.length >= 2
      ? times.reduce((a, b) => Math.max(a, b)) - times.reduce((a, b) => Math.min(a, b))
      : 0;
  const days = Number((spanMs / (24 * 3_600_000)).toFixed(2));
  const { realNames, receivedByGroup } = peopleOf(events);
  const life = lifeOf(events, realNames);
  const acts = actsOf(events);
  const shown = callsOf(calls);

  const groupRates = Array.from(receivedByGroup.entries(), ([scope, received]) => {
    const nCalls = shown.callsByGroup.get(scope) ?? 0;
    return {
      scope,
      received,
      calls: nCalls,
      ratePer100: received > 0 ? Number(((nCalls / received) * 100).toFixed(2)) : 0,
    };
  }).sort((a, b) => b.received - a.received);

  return {
    days,
    lifeDays: life.lifeDays,
    dreamDays: life.dreamDays,
    lifeLeaks: life.lifeLeaks,
    curiositiesGenerated: life.curiositiesGenerated,
    dreamSharesShown: shown.dreamSharesShown,
    channelSharesShown: shown.channelSharesShown,
    topicOpens: acts.topicOpens,
    topicAdvances: acts.topicAdvances,
    topicCloses: acts.topicCloses,
    intends: acts.intends,
    fulfils: acts.fulfils,
    recalls: acts.recalls,
    selfNotes: acts.selfNotes,
    selfReplacements: acts.selfReplacements,
    groupRates,
  };
}

/** 收集真实群友/私聊联系人的名字（确定性检验日程表与小事里有没有出现真实人名，life-leak），和各群收到的条数。 */
function peopleOf(events: readonly AliceEvent[]) {
  const realNames = new Set<string>();
  const receivedByGroup = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "message.received") continue;
    const name = e.senderName.trim();
    if (name.length >= 2 && !/^(?:u\d+|user|alice)$/i.test(name)) realNames.add(name);
    if (e.chatType === "group" && !e.isBot) {
      receivedByGroup.set(e.scope, (receivedByGroup.get(e.scope) ?? 0) + 1);
    }
  }
  return { realNames, receivedByGroup };
}

/** 日程表生成了几天、其中带好奇点的几天，和日程里出现的真实人名。 */
function lifeOf(events: readonly AliceEvent[], realNames: ReadonlySet<string>) {
  let lifeDays = 0;
  let dreamDays = 0;
  let curiositiesGenerated = 0;
  const lifeLeaks: string[] = [];
  for (const e of events) {
    if (e.type !== "ponder.done" || e.ponder.kind !== "life") continue;
    lifeDays++;
    const p = e.ponder;
    if (p.curiosities !== undefined && p.curiosities.length > 0) {
      dreamDays++;
      curiositiesGenerated += p.curiosities.length;
    }
    const texts = [
      ...Object.values(p.activities).filter((v): v is string => Boolean(v)),
      ...p.moments.map((m) => m.text),
      ...p.ongoing,
      ...(p.curiosities ?? []).flatMap((c) => [c.topic, c.hook]),
    ];
    for (const t of texts) {
      for (const name of realNames) {
        if (t.includes(name)) lifeLeaks.push(`${p.date}:${name}->${t}`);
      }
    }
  }
  return { lifeDays, dreamDays, curiositiesGenerated, lifeLeaks };
}

/** 做成了的长期连贯动作按种类计数。 */
const ACT_COUNT = {
  "topic-open": "topicOpens",
  "topic-advance": "topicAdvances",
  "topic-close": "topicCloses",
  intend: "intends",
  fulfil: "fulfils",
  recall: "recalls",
  "note-self": "selfNotes",
} as const;
type ActCount = (typeof ACT_COUNT)[keyof typeof ACT_COUNT] | "selfReplacements";

function actsOf(events: readonly AliceEvent[]): Record<ActCount, number> {
  const n: Record<ActCount, number> = {
    topicOpens: 0,
    topicAdvances: 0,
    topicCloses: 0,
    intends: 0,
    fulfils: 0,
    recalls: 0,
    selfNotes: 0,
    selfReplacements: 0,
  };
  for (const e of events) {
    if (e.type !== "act.done") continue;
    const key = ACT_COUNT[e.act.kind as keyof typeof ACT_COUNT] as ActCount | undefined;
    if (key) n[key]++;
    if (e.act.kind === "note-self" && e.act.replaces) n.selfReplacements++;
  }
  return n;
}

/** 发言调用：各群几次，提示词里写了她自己想到的事、频道新帖的各几次。 */
function callsOf(calls: readonly LongAuditCall[]) {
  let dreamSharesShown = 0;
  let channelSharesShown = 0;
  const callsByGroup = new Map<string, number>();
  for (const c of calls) {
    if (c.scope.startsWith("telegram:-")) {
      callsByGroup.set(c.scope, (callsByGroup.get(c.scope) ?? 0) + 1);
    }
    for (const cause of c.causes ?? []) {
      if (cause.includes("我刚才自己想到")) dreamSharesShown++;
      else if (cause.includes("share")) channelSharesShown++;
    }
  }
  return { dreamSharesShown, channelSharesShown, callsByGroup };
}
