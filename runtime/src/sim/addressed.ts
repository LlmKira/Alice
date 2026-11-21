/**
 * 关系模型在线上的足迹（docs/research/relationship.md 第 1、2 片）。普查算不出来（它的输入里没有冲着她的消息，也没有
 * 外壳判的口气），这里按生产的机制折叠 Journal：
 * 第 1 片，回避按人记（pressure/relation.ts）：在群里每条冲着她的消息（点名、回复她）上问意愿层——
 * - addressed：群里冲着她的消息几条；woken：叫醒分数 > 0.5 的几条；
 * - rescued：按人读回避时回她话值得（不进出会话的动作里最好的 NSV > 0），按会话读就不值得的几条。机制在线上起作用
 *   就大于 0。按会话读时，被晾着的群里点她名，最好的意愿可能是退群（退群缓解回避），所以这里比回话，不比叫醒分数；
 * - readRoom：冲着她的消息上，回避代价还在读会话那一项的几条。设计值 0：不为 0 就是 relation 没折进世界或没接上意愿层。
 * 第 2 片，口气不好的来找不推向开心（affect 的 warmth.tone）：
 * - glad：有人来找她，心情被推向"开心（因为谁来找我）"的次数；
 * - unfriendlyGlad：其中那条话后来被判成冷淡或敌意、判出来之后那次推动还是她当时的心情的次数。设计值 0。
 * 用法：pnpm addressed <journal.db>（只读；只打印计数）
 */
import { pathToFileURL } from "node:url";
import {
  compositionOf,
  intentionsFor,
  PRODUCTION,
  type World,
  willOf,
  willWake,
} from "../mechanisms/pressure/index.js";
import { personAversion } from "../mechanisms/pressure/relation.js";
import { productionMechanisms } from "../mechanisms/registry.js";
import { affordanceOf, affordances, memberAfter } from "../mind/affordances.js";
import type { AliceEvent } from "../mind/events.js";
import type { Mechanism } from "../mind/mechanism.js";
import { emptyState } from "../mind/state.js";
import { step, towardHer } from "../mind/step.js";
import { readJournal } from "./trace.js";

export interface AddressedFootprint {
  addressed: number;
  woken: number;
  rescued: number;
  readRoom: number;
  glad: number;
  unfriendlyGlad: number;
}

export function addressedFootprint(
  events: readonly AliceEvent[],
  mechanisms: readonly Mechanism[] = productionMechanisms(true),
): AddressedFootprint {
  const pressure = mechanisms.find((m) => compositionOf(m));
  if (!pressure) throw new Error("no pressure field among the mechanisms");
  const wake = willWake(affordances, PRODUCTION);
  const perPerson = wake.policy;
  const perRoom = willOf({ ...PRODUCTION, relation: undefined });
  const send = affordanceOf("send");
  /** 不进出会话的动作里最好的 NSV（回她的话）。 */
  const answering = wake.affordances.filter((a) => memberAfter(a) === undefined);
  const answer = (world: World, scope: string, at: number, policy: typeof perPerson) =>
    Math.max(-Infinity, ...intentionsFor(world, answering, scope, at, policy).map((i) => i.nsv));
  const out: AddressedFootprint = {
    addressed: 0,
    woken: 0,
    rescued: 0,
    readRoom: 0,
    glad: 0,
    unfriendlyGlad: 0,
  };
  /** 推向开心的那条消息 → 推的时刻。 */
  const pushed = new Map<string, number>();
  let state = emptyState;
  for (const logged of events) {
    const e = towardHer(state, logged);
    state = step(state, e, mechanisms).state;
    const world = state.mechanisms[pressure.name] as World | undefined;
    if (!world) continue;
    if (e.type === "message.received" && (e.directed || e.chatType === "private")) {
      const a = world.affect.appraisal;
      if (a && a.at === e.at && a.word === "开心" && a.why?.endsWith("来找我")) {
        pushed.set(`${e.scope}:${e.messageId}`, e.at);
        out.glad++;
      }
    }
    if (e.type === "message.perceived" && (e.tone === "cold" || e.tone === "hostile")) {
      const at = pushed.get(`${e.scope}:${e.messageId}`);
      if (at !== undefined && world.affect.appraisal?.at === at) out.unfriendlyGlad++;
    }
    if (e.type !== "message.received" || !e.directed || e.chatType !== "group") continue;
    if (!world.chats[e.scope]) continue;
    const r = wake.why(e.scope, e, e.at, world);
    out.addressed++;
    if ((r && "score" in r ? r.score : 0) > 0.5) out.woken++;
    if (answer(world, e.scope, e.at, perPerson) > 0 && answer(world, e.scope, e.at, perRoom) <= 0)
      out.rescued++;
    if (personAversion(world, e.scope, send, e.at) === null) out.readRoom++;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [db] = process.argv.slice(2);
  if (!db) throw new Error("usage: addressed <journal.db>");
  console.log(JSON.stringify(addressedFootprint(readJournal(db).events)));
}
