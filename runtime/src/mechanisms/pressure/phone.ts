/**
 * 拿起手机（候选 phone，PLAN 第 51 件；docs/research/phone-focus-2026-11-13.md）。
 *
 * 研究员 2026-11-13："我们更喜欢一段时间的连续发言，而不是连续密集的单点发言。偏好尖峰，更像人类。"
 * 生产里节律每隔 Δt（1–5 分钟）就跨所有会话排一次序，她醒着的整天都在"看手机"：线上闭环回放里一天 58 段、
 * 每段多半一轮。真人不是这样（Wu et al. 2010，短信一个月）：一段通信随机地开始（泊松），开始之后两人
 * 你来我往、间隔短（幂律），对方不回了这一段就散了；间隔因此是两峰的。
 *
 * 世界的规律（不写行为）：
 * - 她拿着手机才看得到没人找她的会话。手机放着时，节律那条路只看得到有人在等她的会话（awaited）和她正在
 *   聊着的会话；被点名、私聊、她在对话里时别人的话，照旧各走各的路（每个会话的状态机照旧并行，没有共用的行动槽）。
 * - 什么时候拿起：有人找她（私聊、点名、回复她），她发了一条，或她在聊着的会话里有人接着说，手机就在手上；
 *   没人找她时，醒着的每一格按泊松过程拿起（noise.drawn 的 pickup 键）。她看了、没说话不算：有来有回才续上。
 * - 放下：手上最后一件事之后 SESSION_GAP 还没有新的事。
 * - 焦点：拿着手机、手上有正在聊着的会话时，节律只看这几个会话和在等她的会话；一段都没在聊时才看所有会话
 *   （刚拿起时扫一眼列表）。没有焦点这一条时（零成本对照），她拿着手机时照样一格一个会话地冒单句：
 *   没人找时开始的段每天 19 对 11，叫停以后还开口 1 次。
 *
 * 两个数从真人数据学（2 月 0、A、B 和线上 11-12–13，每个群说得最多的四分之一人；脚本和读数在
 * eval-artifacts/phone-focus/）：
 * - SESSION_GAP：同一人相邻两轮的间隔取对数，两成分高斯混合的分界（Wu 的两峰之间）：5.2 分钟。
 * - PICKUP_MEAN：段与段之间超出 SESSION_GAP 的那部分（不超过 6 小时，Wu 去掉了跨夜的）是指数的，均值 36.9 分钟
 *   （四份数据分别 27.7–41.0）：随机开始一段的特征间隔。
 * 她一次在线跟几个会话、在线多久，不另设数：由这两个数、她在聊着的会话自己的节奏（dwell 的 groupTheta）和
 * 别人接不接她的话一起决定。
 */
import { NOISE_EVERY_MS, normalCdf } from "../../mind/noise.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { isAsleep } from "./sleep.js";
import { dwellSince } from "./turn.js";
import { type ChatNode, isSolicited, SOLICITED_FOR } from "./world.js";

const MIN = 60_000;

/** 在线段的分界：最后一件事之后这么久没有新的事，手机就放下了（真人的两峰之间，见文件头）。 */
export const SESSION_GAP = 5.2 * MIN;
/** 手机放着时，平均隔这么久拿起一次（醒着的时间；泊松，见文件头）。 */
export const PICKUP_MEAN = 36.9 * MIN;

export interface PhoneState {
  /** 手上最后一件事的时刻（她说、有人找她、她聊着的会话里有人说话）。 */
  activeAt: number;
  /** 抽中的下一次拿起的时刻（可能在这一格稍后；0 = 没有）。 */
  pickupAt: number;
  /** 一共拿起过几次（footprint）。 */
  pickups: number;
}

export const emptyPhone: PhoneState = { activeAt: 0, pickupAt: 0, pickups: 0 };

/** 她此刻拿着手机。 */
export function online(phone: PhoneState | undefined, now: number): boolean {
  if (!phone) return false;
  const picked = phone.pickupAt > 0 && phone.pickupAt <= now ? phone.pickupAt : 0;
  const last = Math.max(phone.activeAt, picked);
  return last > 0 && now - last <= SESSION_GAP;
}

/** 她正在这个会话里聊着：群里她开口后的这段对话还开着（dwell）；私聊里她说过话、来回还没停过 SESSION_GAP。 */
function talking(chat: ChatNode, now: number): boolean {
  if (chat.chatType === "group") return dwellSince(chat, now) !== null;
  return (
    chat.lastAliceAt > 0 && now - Math.max(chat.lastAliceAt, chat.lastIncomingAt) <= SESSION_GAP
  );
}

/**
 * 有人在找她、她还没回：在等她（isSolicited），或者有人点名、回复了她，她看过但还没在这里说过话，在
 * SOLICITED_FOR 之内（和私聊里"对方说了最后一句、她还没回"同一个时限）。通知一直在锁屏上，手机放着也看得到。
 */
function awaited(chat: ChatNode, now: number): boolean {
  return (
    isSolicited(chat, now) ||
    (chat.lastDirectedAt > chat.lastAliceAt && now - chat.lastDirectedAt <= SOLICITED_FOR)
  );
}

/**
 * 这一格（从 now 起 NOISE_EVERY_MS）里她拿不拿起手机：醒着、手机放着时，按泊松过程的概率 1 − exp(−Δ/PICKUP_MEAN)；
 * 拿起的时刻是均匀数落在概率里的位置（仍是均匀的）。
 */
export function drawPickup(phone: PhoneState, now: number, z: number | undefined): number {
  if (z === undefined || isAsleep(now) || online(phone, now)) return 0;
  const p = 1 - Math.exp(-NOISE_EVERY_MS / PICKUP_MEAN);
  const u = normalCdf(z);
  return u < p ? now + Math.floor((u / p) * NOISE_EVERY_MS) : 0;
}

export const phone: PressureFeature = feature({
  name: "phone",
  provides: ["phone"],
  uses: ["chats.turn.dwell"],
  reduce: (before, after, event) => {
    const p = after.phone ?? emptyPhone;
    switch (event.type) {
      case "noise.drawn": {
        const at = drawPickup(p, event.at, event.draws.pickup);
        return at > 0 ? { ...after, phone: { ...p, pickupAt: at, pickups: p.pickups + 1 } } : after;
      }
      case "message.sent":
        return { ...after, phone: { ...p, activeAt: event.at } };
      case "message.received": {
        // 有人找她（通知），或她聊着的会话里有人接着说。她自己看了、没说话不算：那样她一看就再看，
        // 节律的间隔（最长 5 分钟）比 SESSION_GAP 短，手机就永远放不下（零成本诊断：一半的时钟格在手上）。
        const chat = before.chats[event.scope];
        return event.directed || (chat && talking(chat, event.at))
          ? { ...after, phone: { ...p, activeAt: event.at } }
          : after;
      }
      default:
        return after;
    }
  },
  will: {
    /** 节律到点时这个会话在不在她眼前。 */
    visible: (world: View<"phone" | "chats.turn.dwell">, scope: string, now: number) => {
      const chat = world.chats[scope];
      if (!chat) return true;
      if (awaited(chat, now) || talking(chat, now)) return true;
      if (!online(world.phone, now)) return false;
      return !Object.values(world.chats).some((c) => talking(c, now));
    },
  },
});
