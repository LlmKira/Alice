/**
 * 两种按规则反应的模拟群（PLAN 第 7 件，不调模型）。规则照线上真人对她的反应定：eval-artifacts/world-sim/calib/real.jsonl，
 * 她在群里的每一轮之后 5 分钟内的回复，口气是判别员离线判的。
 * - fond，"互相损，但开心"（玩笑和平静的窗口 B、C，26 轮）：一半的轮有人接，接的话 9/16 友好、7/16 中性；没有人骂她、叫停。
 *   四个人各自以 0.16 的概率回她（四人里至少一人接的概率约 0.5）。
 * - sick，"真的嫌她"（11-13 骂战窗口 F，25 轮）：四个人照 F 里各自的样子回她——
 *   A 回 56% 的轮，14 条里 12 条敌意、1 条冷淡、1 条友好，有 1 条叫她别回；
 *   B 回 76% 的轮，每次约 1.4 条，27 条里 12 敌意、5 中性、10 友好（跟着起哄又不时骂她）；
 *   C 回 16%，6 条里 5 友好、1 敌意；D 回 12%，3 条里 2 中性、1 友好。
 * 两个群里别人之间每分钟约两条闲聊（B、C 窗口每分钟 1.1–2.8 条），不冲着她。回复在她说完 10–140 秒后到。
 * 她被叫醒就说一句（只看叫醒和收手，不看说什么）。口气在她下一次开口时一起判：外壳只在叫醒她时判还没判过的冲着她的话。
 * 抽样按哈希，确定。
 *
 * 用法：tsx src/sim/rooms.ts [arm…]（默认 production），打印每个群、每组的读数。
 */
import { unit } from "../mechanisms/hash.js";
import type { AliceEvent, MessageReceived, MessageSent, Tone } from "../mind/events.js";
import type { Mechanism } from "../mind/mechanism.js";
import { replay } from "./replay.js";

const S = 1000;
const MIN = 60 * S;
/** 当地（UTC+8）下午两点多开始：她醒着。 */
const T0 = 1_771_000_000_000 - 10 * 3_600_000;

export type Room = "fond" | "sick";

interface Member {
  id: string;
  /** 她的一轮之后回她的概率。 */
  replies: number;
  /** 回她时再多回一条的概率。 */
  more: number;
  tones: ReadonlyArray<readonly [Tone, number]>;
  /** 一条回复是叫她别回的概率。 */
  stop: number;
}

const FOND: readonly Member[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  replies: 0.16,
  more: 0,
  tones: [
    ["friendly", 9],
    ["neutral", 7],
  ],
  stop: 0,
}));

const SICK: readonly Member[] = [
  {
    id: "a",
    replies: 14 / 25,
    more: 0,
    tones: [
      ["hostile", 12],
      ["cold", 1],
      ["friendly", 1],
    ],
    stop: 1 / 14,
  },
  {
    id: "b",
    replies: 19 / 25,
    more: 8 / 19,
    tones: [
      ["hostile", 12],
      ["neutral", 5],
      ["friendly", 10],
    ],
    stop: 0,
  },
  {
    id: "c",
    replies: 4 / 25,
    more: 0,
    tones: [
      ["friendly", 5],
      ["hostile", 1],
    ],
    stop: 0,
  },
  {
    id: "d",
    replies: 3 / 25,
    more: 0,
    tones: [
      ["neutral", 2],
      ["friendly", 1],
    ],
    stop: 0,
  },
];

const draw = (tones: Member["tones"], u: number): Tone => {
  const total = tones.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  for (const [t, w] of tones) {
    acc += w / total;
    if (u < acc) return t;
  }
  return (tones.at(-1) as readonly [Tone, number])[0];
};

export interface RoomRun {
  room: Room;
  arm: string;
  /** 她开口的时刻。 */
  turns: number[];
  /** 别人回她的话、判出来的口气。 */
  tones: Array<{ at: number; tone: Tone; stop: boolean }>;
}

/** 在一个模拟群里跑一组机制 hours 小时。 */
export async function runRoom(
  room: Room,
  arm: string,
  mechanisms: readonly Mechanism[],
  hours = 3,
): Promise<RoomRun> {
  const scope = room === "fond" ? "telegram:-901" : "telegram:-902";
  const members = room === "fond" ? FOND : SICK;
  const line = (at: number, id: string, o: Partial<MessageReceived> = {}): MessageReceived => ({
    type: "message.received",
    at,
    scope,
    chatType: "group",
    messageId: `${id}@${at}`,
    senderId: `sim:${id}`,
    senderName: id,
    text: "（闲聊）",
    contentType: "text",
    replyToMessageId: null,
    directed: false,
    ...o,
  });
  // 别人之间的闲聊：平均每 30 秒一条，间隔 10–50 秒。
  const events: AliceEvent[] = [line(T0, "a", { directed: true, text: "@Alice 在吗" })];
  for (let at = T0 + 20 * S; at < T0 + hours * 60 * MIN; ) {
    const who = members[Math.floor(unit(`${room}:who:${at}`) * members.length)] as Member;
    events.push(line(at, who.id));
    at += 10 * S + Math.floor(unit(`${room}:gap:${at}`) * 40 * S);
  }
  const unjudged: Array<{ id: string; tone: Tone; stop: boolean }> = [];
  const run: RoomRun = { room, arm, turns: [], tones: [] };
  const respond = (sent: MessageSent): AliceEvent[] => {
    if (sent.scope !== scope) return [];
    run.turns.push(sent.at);
    // 她这次被叫醒：之前到的冲着她的话一起判口气。
    const out: AliceEvent[] = unjudged.splice(0).map((r) => {
      run.tones.push({ at: sent.at, tone: r.tone, stop: r.stop });
      return {
        type: "message.perceived",
        at: sent.at,
        scope,
        messageId: r.id,
        tone: r.tone,
        ...(r.stop ? { stop: true as const } : {}),
      };
    });
    for (const m of members) {
      const key = `${room}:${m.id}:${sent.at}`;
      if (unit(`${key}:replies`) >= m.replies) continue;
      const n = unit(`${key}:more`) < m.more ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const at = sent.at + 10 * S + Math.floor(unit(`${key}:${i}:delay`) * 130 * S);
        const reply = line(at, m.id, { directed: true, replyToMessageId: sent.messageId });
        const tone = draw(m.tones, unit(`${key}:${i}:tone`));
        const stop = unit(`${key}:${i}:stop`) < m.stop;
        out.push(reply);
        // 判口气要等她下一次被叫醒；到的时刻在那之前就排进去。
        unjudged.push({ id: reply.messageId, tone, stop });
      }
    }
    return out;
  };
  await replay(events, {
    mechanisms,
    tickMs: 10 * S,
    speech: (r) =>
      r.scope === scope ? { acts: [{ kind: "send", text: "嗯嗯", replyTo: null }] } : { acts: [] },
    respond,
  });
  return run;
}

/** 一次运行的读数：每小时她开口几轮、第一次判出翻脸的口气之后多久她还在说。 */
export function summary(run: RoomRun, hours = 3): string {
  const perHour = Array.from(
    { length: hours },
    (_, h) => run.turns.filter((t) => t >= T0 + h * 60 * MIN && t < T0 + (h + 1) * 60 * MIN).length,
  );
  const hostile = run.tones.filter((t) => t.tone === "hostile" || t.tone === "cold").length;
  const stops = run.tones.filter((t) => t.stop).length;
  return `${run.room} ${run.arm.padEnd(10)} turns per hour ${perHour.join(" / ")}; replies judged ${run.tones.length}, cold or hostile ${hostile}, stop ${stops}`;
}

async function main(): Promise<void> {
  const { arms } = await import("./will-arms.js");
  const all = arms({});
  const names = process.argv.slice(2);
  for (const room of ["fond", "sick"] as const) {
    for (const arm of names.length > 0 ? names : ["production"]) {
      const list = all[arm];
      if (!list) throw new Error(`no arm ${arm}`);
      console.log(summary(await runRoom(room, arm, list)));
    }
  }
}

if (process.argv[1]?.endsWith("rooms.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
