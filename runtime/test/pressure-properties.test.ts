/**
 * 意愿层的闭环性质（docs/research/theory-audit.md 第七节）。论文的"非静默"定理换成两条可检验的性质：
 * - S2 沉默可达：对方一直不回，她对这个人连着主动开口不超过 2 月真人的上限（3 次）。
 * - S3 义务可达：别人对她说的话（私聊、群里点名），在她自己连发无回应之后也仍然值得接。
 * - A1 点名不替别人背账：群里她主动说的话被晾着，不让她拒绝一个冲着她说话、没伤过她的人
 *   （docs/research/relationship.md 第 1 片，线上 12:17 那次）。
 * 只读压力场代码；时间、层级与会话类型都扫一遍，而不是只测一个点。
 */
import { describe, expect, it } from "vitest";
import {
  affect,
  intentionsFor,
  PEOPLE_LIVE,
  PRODUCTION,
  people,
  reflectDiaryFlow,
  relation,
  relationTier,
  willOf,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import type { Tier } from "../src/mechanisms/pressure/params.js";
import { TIERS } from "../src/mechanisms/pressure/params.js";
import { STOP, STOP_SHOWN } from "../src/mechanisms/pressure/relation.js";
import { BARE_WILL, rankIntentions, type WillPolicy } from "../src/mechanisms/pressure/will.js";
import {
  aversionAt,
  emptyWorld,
  reduceWorld,
  type World,
} from "../src/mechanisms/pressure/world.js";
import { affordances } from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived, MessageSent } from "../src/mind/events.js";

const T0 = 1_771_000_000_000;
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const DM = "telegram:1";
const GROUP = "telegram:-100";
/** 2 月真人对不回应的人最多连着开口 3 次（p90 为 2；d3d5e04）。 */
const FEB_MAX_BIDS = 3;

let n = 0;
function msg(at: number, o: Partial<MessageReceived> = {}): MessageReceived {
  n++;
  const scope = o.scope ?? DM;
  const group = scope.startsWith("telegram:-");
  return {
    type: "message.received",
    at,
    scope,
    chatType: group ? "group" : "private",
    messageId: `m${n}`,
    senderId: o.senderId ?? "contact:1",
    senderName: "池塘",
    text: "hi",
    contentType: "text",
    replyToMessageId: null,
    directed: !group,
    ...o,
  };
}
function sent(at: number, scope = DM): MessageSent {
  n++;
  return { type: "message.sent", at, scope, messageId: `s${n}`, text: "嗯", kind: "text" };
}
type Reduce = (world: World, event: AliceEvent) => World;
// 只传世界和事件：Array.reduce 的第三个参数（下标）不能落进 reduceWorld 的可选参数。
const fold = (events: AliceEvent[], from: World = emptyWorld, reduce: Reduce = reduceWorld) =>
  events.reduce((w, e) => reduce(w, e), from);

/**
 * 性质对两种配置都要成立：不带作息，和生产配置（PRODUCTION：睡着时行动代价随睡眠深度上升，
 * 没看到的事只在她醒着时变旧）。生产的对话弧带着轮次份额的代价；
 * dwell 的 look 只改叫醒的门（willWake），意愿层和生产相同，不另测。手上的事压着消息有多久，由
 * test/life.test.ts 的空跑查。带着生产组成的配置，世界里要 fold 进
 * relation（谁在等她、按人记的回避：意愿层读它）；其余几样不折，世界只到 base。
 */
const PERSON: Reduce = worldFold({ relation });
const CONFIGS: ReadonlyArray<{ name: string; options: WillPolicy; reduce?: Reduce }> = [
  { name: "no sleep", options: BARE_WILL },
  { name: "production", options: willOf(PRODUCTION), reduce: PERSON },
  /**
   * 候选第 4 片（docs/research/relationship.md）：层级从熟悉度分档（relationTier）。S2、S3 按每一档扫；
   * A1–A3、L1–L3 在这一组上也照旧成立——它只改层级从哪来，不改回避、代价和投入。
   */
  {
    name: "relation-tier",
    options: willOf({ ...PRODUCTION, relation: relationTier }),
    reduce: worldFold({ relation: relationTier }),
  },
  {
    name: "affect-flow-v1",
    options: willOf({
      ...PRODUCTION,
      people: people(PEOPLE_LIVE),
      diary: reflectDiaryFlow,
      affect: affect({
        noise: true,
        lonely: true,
        warmth: { home: true, relevance: true, bids: true, tone: true },
        rejection: true,
        feedback: true,
        body: true,
        willDrive: true,
      }),
    }),
    reduce: worldFold({
      relation,
      affect: affect({
        noise: true,
        lonely: true,
        warmth: { home: true, relevance: true, bids: true, tone: true },
        rejection: true,
        feedback: true,
        body: true,
        willDrive: true,
      }),
    }),
  },
];

function wantsToSend(
  options: WillPolicy,
  w: World,
  scope: string,
  at: number,
  tier: Tier,
): boolean {
  const best = rankIntentions(w, affordances, at, { ...options, tiers: () => tier }).find(
    (i) => i.scope === scope && i.affordance === "send",
  );
  return best !== undefined && best.nsv > 0;
}

/** 本地（UTC+8）某天某个钟点；T0 是本地 2 月 14 日 0:26。 */
const localAt = (day: number, hour: number) => T0 - ((T0 + 8 * H) % D) + day * D + hour * H;

/** 每隔 `every` 检查一次，想说就说、没人回；返回 `horizon` 内她主动开口的次数。 */
function unansweredBidsWith(
  options: WillPolicy,
  start: World,
  scope: string,
  tier: Tier,
  every: number,
  horizon: number,
  reduce: Reduce = reduceWorld,
) {
  let w = start;
  let bids = 0;
  for (let at = T0 + every; at <= T0 + horizon; at += every) {
    if (!wantsToSend(options, w, scope, at, tier)) continue;
    bids++;
    w = fold([sent(at, scope)], w, reduce);
  }
  return { bids, world: w };
}

for (const config of CONFIGS) {
  const o = config.options;
  const fold = (events: AliceEvent[], from: World = emptyWorld) =>
    events.reduce((w, e) => (config.reduce ?? reduceWorld)(w, e), from);
  const unansweredBids = (
    options: WillPolicy,
    start: World,
    scope: string,
    tier: Tier,
    every: number,
    horizon: number,
  ) => unansweredBidsWith(options, start, scope, tier, every, horizon, config.reduce);
  describe(`[${config.name}]`, () => {
    describe("S2 silence is reachable: unanswered bids stay within Feb's range", () => {
      const spacings = [10 * MIN, H, 3 * H, D];
      for (const tier of TIERS) {
        for (const every of spacings) {
          it(`private, tier ${tier}, checked every ${every / MIN} min, 30 days`, () => {
            const start = fold([msg(T0 - MIN), sent(T0)]);
            expect(unansweredBids(o, start, DM, tier, every, 30 * D).bids).toBeLessThanOrEqual(
              FEB_MAX_BIDS,
            );
          });
        }
      }
      // 群里没人接话本来常见，没有真人上限可对照，所以不写断言（见下面的 L1–L3：现在被冷落一次，意愿给出的是离开）。
    });

    describe("S3 obligation stays reachable after her own unanswered bids", () => {
      for (const tier of TIERS) {
        it(`private, tier ${tier}: the person finally writes back (local noon)`, () => {
          const start = fold([msg(T0 - MIN), sent(T0)]);
          const { world } = unansweredBids(o, start, DM, tier, H, 3 * D);
          const at = localAt(4, 12);
          const w = fold([msg(at)], world);
          expect(wantsToSend(o, w, DM, at + MIN, tier)).toBe(true);
        });

        // 夜里来的私聊：睡着时可以不接，但最晚醒来后 10 分钟内要值得接（docs/spec/north-star.md：睡着时看不到，醒来再处理）。
        // 只对作息配置成立（不带作息时义务按墙上时间消退，6 个多小时后远一些的人的话就不再值得接），
        // 所以只在作息配置下注册。
        if (config.name !== "no sleep") {
          it(`private, tier ${tier}: a message at 3:00 is taken up by 10 minutes after she wakes`, () => {
            const at = localAt(2, 3);
            const w = fold([msg(at)], fold([msg(T0 - MIN), sent(T0)]));
            expect(wantsToSend(o, w, DM, localAt(2, 9.5) + 10 * MIN, tier)).toBe(true);
          });
        }
      }

      it("group: being named after she was ignored there (afternoon)", () => {
        const t = localAt(1, 14);
        let w = fold([msg(t - MIN, { scope: GROUP, senderId: "contact:2" }), sent(t, GROUP)]);
        for (let k = 1; k <= 6; k++)
          w = fold([msg(t + k * 10 * MIN, { scope: GROUP, senderId: "contact:2" })], w);
        const at = t + 2 * H;
        w = fold([msg(at, { scope: GROUP, senderId: "contact:3", directed: true })], w);
        expect(wantsToSend(o, w, GROUP, at + MIN, 150)).toBe(true);
      });
    });

    /**
     * 离开的机会成本（投资模型 Le & Agnew 2003；不可逆决策的等待价值 Dixit & Pindyck 1994）：
     * C_exit = w_exit·tanh(I_h/κ_I) + w_wait/(1 + n_h)，进代价项，不设闸门（与实施方 2026-11-10 商定的两项版）。
     * 实现前（2026-11-10）被冷落一次后 leave 是本群唯一 NSV > 0 的候选（+0.148）。
     */
    function leaveNsv(w: World, at: number): number {
      const leave = rankIntentions(w, affordances, at, { ...o, tiers: () => 150 }).find(
        (i) => i.scope === GROUP && i.affordance === "leave-chat",
      );
      return leave?.nsv ?? Number.NEGATIVE_INFINITY;
    }

    /** 三天里，她每天在群里说一句，都有人回复她：她在这个群里有投入。 */
    function investedGroup(): { world: World; at: number } {
      let w = fold([msg(T0 - MIN, { scope: GROUP, senderId: "contact:2" })]);
      for (let day = 0; day < 3; day++) {
        const at = T0 + day * D;
        const mine = sent(at, GROUP);
        w = fold(
          [
            mine,
            msg(at + 2 * MIN, {
              scope: GROUP,
              senderId: `contact:${2 + day}`,
              replyToMessageId: mine.messageId,
              directed: true,
            }),
          ],
          w,
        );
      }
      return { world: w, at: T0 + 3 * D };
    }

    /** 她说一句，别人接着聊了 12 分钟，没人接她。 */
    function ignoredOnce(w: World, at: number): World {
      return fold(
        [
          sent(at, GROUP),
          ...[3, 7, 12].map((m) => msg(at + m * MIN, { scope: GROUP, senderId: "contact:9" })),
        ],
        w,
      );
    }

    describe("leaving has an opportunity cost", () => {
      it("L1: ignored once in a group that has answered her before, she does not want to leave", () => {
        const { world, at } = investedGroup();
        expect(leaveNsv(ignoredOnce(world, at), at + 30 * MIN)).toBeLessThan(0);
      });

      // 失败（σ_fail）只罚再发一条，不罚离开：三次被拒后 τ̂_aversion ≈ 0.975，离开要成立。
      it("L2: refused three times, she can still leave even a group she invested in", () => {
        const { world, at } = investedGroup();
        let w = world;
        for (let k = 0; k < 3; k++) {
          w = fold(
            [
              sent(at + k * 20 * MIN, GROUP),
              {
                type: "act.failed",
                at: at + k * 20 * MIN + MIN,
                scope: GROUP,
                act: { kind: "send", text: "嗯", replyTo: null },
                reason: "refused",
              },
            ],
            w,
          );
        }
        expect(leaveNsv(w, at + H)).toBeGreaterThan(0);
      });

      it("L3: in a new group with no investment, one ignored line is not yet a reason to leave", () => {
        const start = fold([msg(T0 - MIN, { scope: GROUP, senderId: "contact:2" })]);
        expect(leaveNsv(ignoredOnce(start, T0), T0 + 30 * MIN)).toBeLessThanOrEqual(0);
      });
    });

    /**
     * 复刻线上 12:17：早上 contact:2 回复过她；下午她每小时在群里主动说一句，5 句都被晾着（别人接着聊自己的），
     * 会话的回避攒到约 0.77（线上 0.724）；最后一句之后一小时，contact:2 点她名。他没伤过她。
     */
    function talkedPast(): { world: World; at: number } {
      const morning = localAt(1, 10);
      const first = sent(morning, GROUP);
      let w = fold([
        msg(morning - MIN, { scope: GROUP, senderId: "contact:5" }),
        first,
        msg(morning + MIN, {
          scope: GROUP,
          senderId: "contact:2",
          replyToMessageId: first.messageId,
          directed: true,
        }),
        sent(morning + 2 * MIN, GROUP),
      ]);
      const afternoon = localAt(1, 13);
      for (let k = 0; k < 5; k++) {
        const t = afternoon + k * H;
        w = fold(
          [
            sent(t, GROUP),
            ...[3, 4, 5].map((m) =>
              msg(t + m * MIN, { scope: GROUP, senderId: `contact:${5 + ((k + m) % 3)}` }),
            ),
          ],
          w,
        );
      }
      return { world: w, at: afternoon + 5 * H };
    }

    describe("a mention is not refused because of other people's silence", () => {
      const named = () => {
        const { world, at } = talkedPast();
        return {
          world: fold([msg(at, { scope: GROUP, senderId: "contact:2", directed: true })], world),
          at,
        };
      };

      it("the replica holds: her lines there were talked past (room aversion ≥ 0.7)", () => {
        const { world, at } = named();
        expect(
          aversionAt(world.chats[GROUP] as NonNullable<World["chats"][string]>, at),
        ).toBeGreaterThan(0.7);
      });

      // 不带按人回避的对照（BARE_WILL）把会话的回避算到点她名的人头上：红（it.fails 记下这一点）；读他自己的回避：绿。
      (config.reduce ? it : it.fails)("A1: answering the person who named her is worth it", () => {
        const { world, at } = named();
        expect(wantsToSend(o, world, GROUP, at + MIN, 150)).toBe(true);
      });

      // A2、A3：按人读回避，在不该变的地方和按会话读得一样（去掉 aversion 这一项就是按会话读）。
      if (!config.reduce) return;
      it("A2: with nobody waiting, an unprompted line there costs what the room term says", () => {
        const { world, at } = talkedPast();
        const nsv = (p: WillPolicy) =>
          rankIntentions(world, affordances, at, { ...p, tiers: () => 150 }).find(
            (i) => i.scope === GROUP && i.affordance === "send",
          )?.nsv;
        expect(nsv(o)).toBe(nsv({ ...o, aversion: undefined }));
      });
    });

    (config.reduce ? it : it.skip)(
      "A3: after the person refused her in private, reaching him costs what the room term says",
      () => {
        const at = localAt(1, 14);
        const w = fold([
          msg(at - 2 * H),
          sent(at - H),
          {
            type: "act.failed",
            at: at - H + MIN,
            scope: DM,
            act: { kind: "send", text: "嗯", replyTo: null },
            reason: "refused",
          },
          msg(at),
        ]);
        const nsv = (p: WillPolicy) =>
          rankIntentions(w, affordances, at + MIN, { ...p, tiers: () => 15 }).find(
            (i) => i.scope === DM && i.affordance === "send",
          )?.nsv as number;
        expect(nsv(o)).toBeCloseTo(nsv({ ...o, aversion: undefined }), 12);
      },
    );

    /**
     * A4 叫她别回的人不借别人叫醒她：Ani 在群里叫她别回（外壳判出 stop），Rumun 也在等她回话。之后在那一笔还写在卡片上的
     * 整段时间里（剩到 STOP_SHOWN 以下之前，约 4.2 小时），Ani 的话都不叫醒她；Rumun 的话照样叫醒她。
     */
    (config.reduce ? it : it.skip)(
      "A4: after a stop, the stopper's lines do not wake her for the record's lifetime; another person's still do",
      () => {
        const t = localAt(1, 14);
        const stopLine = msg(t, { scope: GROUP, senderId: "ani", directed: true });
        const start = fold([
          msg(t - 5 * MIN, { scope: GROUP, senderId: "rumun" }),
          sent(t - 4 * MIN, GROUP),
          stopLine,
          {
            type: "message.perceived",
            at: t + 20_000,
            scope: GROUP,
            messageId: stopLine.messageId,
            tone: "hostile",
            stop: true,
          },
          sent(t + 40_000, GROUP),
          msg(t + 2 * MIN, { scope: GROUP, senderId: "rumun", directed: true }),
        ]);
        const wakes = (from: string, at: number) => {
          const line = msg(at, { scope: GROUP, senderId: from, directed: true });
          const w = fold([line], start);
          const best = Math.max(
            ...intentionsFor(w, affordances, GROUP, at, { ...o, tiers: () => 150 }, from).map(
              (i) => i.nsv,
            ),
          );
          return best > 0;
        };
        const lifetime = STOP.tau * Math.log(STOP.gain / STOP_SHOWN);
        for (const after of [3 * MIN, 30 * MIN, H, 2 * H, 3 * H, lifetime - MIN]) {
          expect(wakes("ani", t + after), `Ani +${after / MIN} min`).toBe(false);
          expect(wakes("rumun", t + after), `Rumun +${after / MIN} min`).toBe(true);
        }
      },
    );
  });
}
