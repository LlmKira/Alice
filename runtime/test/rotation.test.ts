import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEvent, type JournaledEvent } from "../src/journal.js";
import { mechanisms as registry } from "../src/mechanisms/registry.js";
import { SELF_SCOPE, type SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, ArmSwitched, MessageReceived } from "../src/mind/events.js";
import type { Mechanism } from "../src/mind/mechanism.js";
import {
  blockOf,
  DAY_START_HOUR,
  inConversation,
  type Mind,
  QUIET_MS,
  type Rotating,
  rotating,
  scheduled,
  switchesDue,
  unitOf,
} from "../src/mind/rotation.js";
import { type AliceState, emptyChat, emptyState } from "../src/mind/state.js";
import { armSummary, northstar } from "../src/northstar.js";
import { createFold, Shell, type ShellPorts } from "../src/shell.js";
import { replay, type SpeechOracle } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";
import { directedWake } from "./directed-wake.js";
import { modelReply } from "./model-reply.js";

const MIN = 60_000;
const H = 60 * MIN;
/** 东八区 2026-11-13 0 点。 */
const DAY0 = Date.parse("2026-11-13T00:00:00+08:00");
const at7 = (day: number) => DAY0 + day * 24 * H + DAY_START_HOUR * H;

const DM = "telegram:1";
const GROUP = "telegram:-5";

function msg(at: number, scope: string, id: string, directed: boolean): MessageReceived {
  return {
    type: "message.received",
    at,
    scope,
    chatType: scope === DM ? "private" : "group",
    messageId: id,
    senderId: `u${id}`,
    senderName: "池塘",
    text: "嗯",
    contentType: "text",
    replyToMessageId: null,
    directed,
  };
}

/** 只改会话里提示词的候选（测试用）：往提示词里加一句事实。 */
const note: Mechanism = {
  name: "note",
  contribute: () => [{ mechanism: "note", kind: "moment", text: "候选在。" }],
};
const answer: SpeechOracle = (request) => ({
  acts: [{ kind: "send", text: "好", replyTo: request.triggerMessageId }],
});

describe("seeded assignment", () => {
  const r = { candidate: "c", seed: "s1", unit: "chat" as const };

  it("cuts the day at DAY_START_HOUR in UTC+8", () => {
    expect(blockOf(at7(0) - 1)).toBe(blockOf(at7(0)) - 1);
    expect(blockOf(at7(0))).toBe(blockOf(at7(1) - 1));
  });

  it("is a function of seed, unit and block only, and gives each arm one day of every pair", () => {
    for (const unit of [DM, GROUP, SELF_SCOPE]) {
      for (let pair = 10_000; pair < 10_050; pair++) {
        const a = scheduled(r, unit, 2 * pair);
        const b = scheduled(r, unit, 2 * pair + 1);
        expect(a).not.toBe(b);
        expect(scheduled({ ...r }, unit, 2 * pair)).toBe(a);
      }
    }
    const order = (seed: string) =>
      Array.from({ length: 40 }, (_, i) => scheduled({ ...r, seed }, DM, 2 * (10_000 + i)));
    expect(order("s1")).not.toEqual(order("s2"));
    expect(new Set(order("s1"))).toEqual(new Set(["production", "candidate"]));
  });

  it("rotates by chat when only in-chat parts change, by her as a whole when a cross-chat part does", () => {
    const all = arms({});
    expect(unitOf(registry, all["no-presence"] as Mechanism[])).toBe("chat");
    expect(unitOf(registry, all["no-floor"] as Mechanism[])).toBe("self");
    expect(() =>
      rotating({ candidate: "no-floor", seed: "s", unit: "chat" }, registry, all["no-floor"] ?? []),
    ).toThrow("rotate it by self");
  });

  it("keeps the two arms' state apart when they share a mechanism name", () => {
    const other: Mechanism = { ...directedWake, contribute: () => [] };
    const m = rotating({ candidate: "c", seed: "s" }, [directedWake], [other]);
    expect(m.candidate.map((x) => x.name)).toEqual(["directed-wake@c"]);
    expect(m.folded.map((x) => x.name)).toEqual(["directed-wake", "directed-wake@c"]);
  });
});

describe("she is in a conversation", () => {
  const t = at7(0);
  const withTimeline = (entries: Array<[number, boolean, boolean]>) => {
    let chat = emptyChat(GROUP, "group", true);
    chat = {
      ...chat,
      timeline: entries.map(([at, hers, directed], i) => ({
        at,
        messageId: String(i),
        sender: hers ? null : { id: "u", name: "u" },
        text: "x",
        contentType: "text",
        replyToMessageId: null,
        ...(directed ? { directed: true as const } : {}),
      })),
    };
    return chat;
  };

  it("while the current run of talk (gaps under QUIET_MS) holds her words or words at her", () => {
    expect(inConversation(withTimeline([[t - 2 * MIN, true, false]]), t)).toBe(true);
    expect(inConversation(withTimeline([[t - 2 * MIN, false, true]]), t)).toBe(true);
    // 别人一直在聊，她在这一串的开头说过。
    const run: Array<[number, boolean, boolean]> = [[t - 20 * MIN, true, false]];
    for (let k = 19; k >= 1; k--) run.push([t - k * MIN, false, false]);
    expect(inConversation(withTimeline(run), t)).toBe(true);
  });

  it("not when the talk went quiet, or the run never had her", () => {
    expect(inConversation(withTimeline([[t - QUIET_MS - 1, true, false]]), t)).toBe(false);
    expect(
      inConversation(
        withTimeline([
          [t - 30 * MIN, true, false],
          [t - 2 * MIN, false, false],
          [t - MIN, false, false],
        ]),
        t,
      ),
    ).toBe(false);
  });

  it("while she is waiting to speak, deciding, or has an errand out", () => {
    const chat = withTimeline([]);
    expect(inConversation(chat, t)).toBe(false);
    expect(
      inConversation(
        {
          ...chat,
          mind: { mode: "deciding", callId: "x", since: t, wakeAgain: false, waking: null },
        },
        t,
      ),
    ).toBe(true);
    expect(
      inConversation({ ...chat, running: [{ at: t, act: { kind: "delegate", task: "x" } }] }, t),
    ).toBe(true);
  });

  it("holds a chat back while she talks there; holds her whole self back while she talks anywhere", () => {
    const busy = {
      ...withTimeline([[t - MIN, true, false]]),
      scope: DM,
      chatType: "private" as const,
    };
    const quiet = withTimeline([[t - 30 * MIN, true, false]]);
    const state: AliceState = { ...emptyState, chats: { [DM]: busy, [GROUP]: quiet } };
    const block = blockOf(t);
    const due = (unit: "chat" | "self") => {
      const seed = seedWhere(unit === "self" ? [SELF_SCOPE] : [DM, GROUP], block, "candidate");
      const mind = rotating({ candidate: "c", seed, unit }, [directedWake], [directedWake, note]);
      return switchesDue(state, t, mind).map((s) => [s.scope, s.arm]);
    };
    expect(due("chat")).toEqual([[GROUP, "candidate"]]);
    expect(due("self")).toEqual([]);
    const later = { ...state, chats: { [DM]: { ...busy, timeline: [] }, [GROUP]: quiet } };
    const seed = seedWhere([SELF_SCOPE], block, "candidate");
    const mind = rotating(
      { candidate: "c", seed, unit: "self" },
      [directedWake],
      [directedWake, note],
    );
    expect(switchesDue(later, t, mind).map((s) => [s.scope, s.arm])).toEqual([
      [SELF_SCOPE, "candidate"],
    ]);
  });
});

/** 这一段排到候选的种子（测试只为了让开头就确定在哪一组）。 */
function seedWhere(units: readonly string[], block: number, arm: "production" | "candidate") {
  for (let i = 0; i < 10_000; i++) {
    const seed = `t${i}`;
    if (units.every((u) => scheduled({ candidate: "c", seed, unit: "chat" }, u, block) === arm))
      return seed;
  }
  throw new Error("no seed");
}

describe("switching only between conversations", () => {
  /** 私聊从 6:30 聊到 8:00，每两分钟一条；群里一直有人在旁边聊（不冲着她）。四天。 */
  const events: AliceEvent[] = [];
  for (let day = 0; day < 4; day++) {
    for (let k = 0; k <= 45; k++) {
      events.push(msg(at7(day) - 30 * MIN + k * 2 * MIN, DM, `d${day}-${k}`, true));
    }
    for (let k = 0; k <= 90; k++) {
      events.push(msg(at7(day) - 45 * MIN + k * MIN, GROUP, `g${day}-${k}`, false));
    }
  }
  events.sort((a, b) => a.at - b.at);

  const run = async (mind: Rotating) => {
    const calls: Array<{ at: number; scope: string; arm: string }> = [];
    const switches: ArmSwitched[] = [];
    let state: AliceState = emptyState;
    await replay(events, {
      mechanisms: mind,
      tickMs: 10_000,
      observe: (event, s) => {
        state = s;
        if (event.type === "arm.switched") switches.push(event);
      },
      speech: (request: SpeechRequest, _id, at) => {
        const note = request.contributions.some((c) => c.mechanism === "note");
        calls.push({ at: at ?? 0, scope: request.scope, arm: note ? "candidate" : "production" });
        return answer(request, _id, at);
      },
    });
    return { calls, switches, state };
  };

  for (const unit of ["chat", "self"] as const) {
    it(`never changes arm inside a conversation (${unit})`, async () => {
      const mind = rotating(
        { candidate: "c", seed: "s1", unit },
        [directedWake],
        [directedWake, note],
      );
      const { calls, switches } = await run(mind);
      expect(switches.length).toBeGreaterThan(0);
      // 私聊每天是一整段对话（两分钟一条，跨过 7 点）：同一段里的调用都在同一组。
      for (let day = 0; day < 4; day++) {
        const inDay = calls.filter(
          (c) => c.scope === DM && c.at >= at7(day) - 31 * MIN && c.at <= at7(day) + 61 * MIN,
        );
        expect(inDay.length).toBeGreaterThan(40);
        expect(new Set(inDay.map((c) => c.arm)).size).toBe(1);
      }
      // 换组都落在私聊那段对话结束、安静满 QUIET_MS 之后（或第一天她还没进对话之前）。
      for (const s of switches.filter((s) => s.scope === DM || s.scope === SELF_SCOPE)) {
        const day = Math.floor((s.at - at7(0) + 12 * H) / (24 * H));
        const last = at7(day) + 60 * MIN;
        expect(s.at < at7(day) - 30 * MIN || s.at >= last + QUIET_MS).toBe(true);
      }
    });
  }

  it("is reproducible: the same seed and events give the same switches; another seed differs", async () => {
    const mind = (seed: string) =>
      rotating({ candidate: "c", seed, unit: "chat" }, [directedWake], [directedWake, note]);
    const a = await run(mind("s1"));
    const b = await run(mind("s1"));
    expect(JSON.stringify(b.switches)).toBe(JSON.stringify(a.switches));
    expect(JSON.stringify(b.calls)).toBe(JSON.stringify(a.calls));
    const other = await run(mind("s9"));
    expect(other.switches.map((s) => s.arm)).not.toEqual(a.switches.map((s) => s.arm));
  });

  it(
    "the live shell journals the same switches the replay computes",
    { timeout: 15_000 },
    async () => {
      const mind = rotating(
        { candidate: "c", seed: "s1", unit: "chat" },
        [directedWake],
        [directedWake, note],
      );
      const replayed = await run(mind);

      let now = events[0]?.at ?? 0;
      const journal: JournaledEvent[] = [];
      let tick: (() => void) | null = null;
      const ports: ShellPorts = {
        now: () => now,
        append: (event) => void journal.push(event),
        journaled: () => {},
        callModel: async () => modelReply([{ kind: "send", text: "好", replyTo: null }]),
        act: async () => ({ kind: "posted", messageId: String(journal.length) }),
        schedule: (_ms, fire) => {
          tick = fire;
          return () => {};
        },
        background: async () => {
          throw new Error("no errands");
        },
        fatal: (error) => {
          throw error;
        },
        log: () => {},
        paused: () => false,
      };
      const shell = new Shell(ports, mind, "你是 Alice。", createFold(mind).result());
      shell.start();
      const settle = async () => {
        for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      };
      // 和回放一样的时钟：10 秒一格，对齐到整倍数；消息在自己的时刻进来，模型当场回（零延迟）。
      let next = Math.ceil(now / 10_000) * 10_000;
      for (const event of events) {
        while (next <= event.at) {
          now = next;
          (tick as unknown as () => void)();
          await settle();
          next += 10_000;
        }
        now = event.at;
        shell.dispatch(event);
        await settle();
      }
      const live = journal.filter((e): e is ArmSwitched => e.type === "arm.switched");
      expect(live).toEqual(replayed.switches);
      // 折叠这份日志得到同样的分组。
      const fold = createFold(mind);
      for (const e of journal) fold.feed(e);
      expect(fold.result().state.arms).toEqual(shell.current.arms);
      await shell.stop();
    },
  );

  it("is written to and read back from the Journal", () => {
    const e: ArmSwitched = {
      type: "arm.switched",
      at: at7(0),
      scope: SELF_SCOPE,
      arm: "candidate",
      candidate: "phone",
      block: blockOf(at7(0)),
    };
    expect(decodeEvent(e.type, e.scope, JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(decodeEvent(e.type, e.scope, { ...e, arm: null })).toEqual({ ...e, arm: null });
  });
});

const ROTATION_SCENE = "scenes/synthetic-v1/h06-tuesday-evening/events.jsonl";
const hasRotationScene = existsSync(ROTATION_SCENE);

describe.skipIf(!hasRotationScene)("one arm is the arm it rotates in", () => {
  // 一个真实的场景（群聊），在生产和两个候选上：轮换里一直在某一组，和单独跑那一组的提示词逐字节相同。
  const scene = hasRotationScene
    ? readFileSync(ROTATION_SCENE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AliceEvent)
    : [];
  const first = scene[0]?.at ?? 0;
  const scopes = [...new Set(scene.flatMap((e) => ("scope" in e ? [e.scope] : [])))];
  const requests = async (mind: Mind, events: readonly AliceEvent[]) => {
    const seen: string[] = [];
    await replay(events, {
      mechanisms: mind,
      tickMs: 10_000,
      speech: (request, id, at) => {
        seen.push(JSON.stringify(request));
        return answer(request, id, at);
      },
    });
    return seen;
  };

  for (const name of ["no-presence", "no-floor"]) {
    for (const arm of ["production", "candidate"] as const) {
      it(`${name}: the ${arm} arm`, { timeout: 15_000 }, async () => {
        const all = arms({});
        const candidate = all[name] as Mechanism[];
        const unit = unitOf(registry, candidate);
        const units = unit === "self" ? [SELF_SCOPE] : scopes;
        const seed = seedWhere(units, blockOf(first), arm);
        const mind = rotating({ candidate: name, seed }, registry, candidate);
        // 开头就在这一组（不然第一段对话照旧用生产，到安静了才换）。
        const start: AliceEvent[] = units.map((scope) => ({
          type: "arm.switched",
          at: first - 1,
          scope,
          arm,
          candidate: name,
          block: blockOf(first),
        }));
        const plain = await requests(arm === "production" ? registry : candidate, scene);
        const rotated = await requests(mind, [...start, ...scene]);
        expect(plain.length).toBeGreaterThan(0);
        expect(rotated).toEqual(plain);
      });
    }
  }
});

describe("north-star readings by arm", () => {
  it("splits each day by the arm in force when things happened, and leaves the default alone", () => {
    const day = at7(0) + H;
    const events: AliceEvent[] = [
      { type: "arm.switched", at: day, scope: DM, arm: "candidate", candidate: "c", block: 0 },
      msg(day + MIN, DM, "1", true),
      msg(day + MIN, GROUP, "2", true),
      {
        type: "message.sent",
        at: day + 2 * MIN,
        scope: DM,
        messageId: "s1",
        text: "好",
        kind: "text",
      },
      {
        type: "message.sent",
        at: day + 2 * MIN,
        scope: GROUP,
        messageId: "s2",
        text: "好",
        kind: "text",
      },
      { type: "arm.switched", at: day + 3 * H, scope: DM, arm: null, candidate: "c", block: 0 },
      msg(day + 4 * H, DM, "3", true),
    ];
    const plain = northstar(events).days;
    expect(plain.map((d) => d.arm)).toEqual([undefined]);
    const rows = northstar(events, { byArm: true }).days;
    expect(rows.map((d) => [d.arm, d.inbound, d.herMessages])).toEqual([
      ["c", 1, 1],
      ["none", 2, 1],
    ]);
    expect(armSummary(rows).map((a) => [a.arm, a.days, a.inbound])).toEqual([
      ["c", 1, 1],
      ["none", 1, 2],
    ]);
  });
});
