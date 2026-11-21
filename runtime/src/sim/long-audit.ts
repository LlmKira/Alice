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
  const spanMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;
  const days = Number((spanMs / (24 * 3_600_000)).toFixed(2));

  // 收集真实群友/私聊联系人的名字，用来确定性检验日程表与小事里有没有出现真实人名（life-leak）。
  const realNames = new Set<string>();
  const receivedByGroup = new Map<string, number>();
  for (const e of events) {
    if (e.type === "message.received") {
      const name = e.senderName.trim();
      if (name.length >= 2 && !/^(?:u\d+|user|alice)$/i.test(name)) realNames.add(name);
      if (e.chatType === "group" && !e.isBot) {
        receivedByGroup.set(e.scope, (receivedByGroup.get(e.scope) ?? 0) + 1);
      }
    }
  }

  let lifeDays = 0;
  let dreamDays = 0;
  let curiositiesGenerated = 0;
  const lifeLeaks: string[] = [];
  let topicOpens = 0;
  let topicAdvances = 0;
  let topicCloses = 0;
  let intends = 0;
  let fulfils = 0;
  let recalls = 0;
  let selfNotes = 0;
  let selfReplacements = 0;

  for (const e of events) {
    if (e.type === "ponder.done" && e.ponder.kind === "life") {
      lifeDays++;
      const p = e.ponder;
      if (p.curiosities?.length) {
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
    } else if (e.type === "act.done") {
      switch (e.act.kind) {
        case "topic-open":
          topicOpens++;
          break;
        case "topic-advance":
          topicAdvances++;
          break;
        case "topic-close":
          topicCloses++;
          break;
        case "intend":
          intends++;
          break;
        case "fulfil":
          fulfils++;
          break;
        case "recall":
          recalls++;
          break;
        case "note-self":
          selfNotes++;
          if (e.act.replaces) selfReplacements++;
          break;
      }
    }
  }

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

  const groupRates = [...receivedByGroup.entries()]
    .map(([scope, received]) => {
      const nCalls = callsByGroup.get(scope) ?? 0;
      return {
        scope,
        received,
        calls: nCalls,
        ratePer100: received > 0 ? Number(((nCalls / received) * 100).toFixed(2)) : 0,
      };
    })
    .sort((a, b) => b.received - a.received);

  return {
    days,
    lifeDays,
    dreamDays,
    lifeLeaks,
    curiositiesGenerated,
    dreamSharesShown,
    channelSharesShown,
    topicOpens,
    topicAdvances,
    topicCloses,
    intends,
    fulfils,
    recalls,
    selfNotes,
    selfReplacements,
    groupRates,
  };
}
