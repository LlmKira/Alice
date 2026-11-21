/**
 * 一个概念一个主人（PLAN 第 63 件；组合核在 src/mind/compose.ts）：
 * - 生产里每一块恰好一个提供者，被读的每一块生产里都有人写；
 * - 两个部分写同一块的地方（amends）就是要合并的地方，这里逐条列出，合并一处删一条；
 * - 每个组别都能组合，缺块不激活的部分、读到空块的地方都列出来；
 * - 拿掉一个提供者，读它的部分跟着不激活；
 * - 写入审计：在几个场景上真跑一遍，每一样实际写的块都在它的声明里。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errands } from "../src/mechanisms/errands.js";
import { familiar } from "../src/mechanisms/familiar.js";
import { language } from "../src/mechanisms/language.js";
import { type ChatSlice, feature, type Slice } from "../src/mechanisms/pressure/feature.js";
import {
  auditedFold,
  compositionOf,
  memory,
  PRODUCTION,
  partsOf,
  people,
  pressureProduction,
  WORLD_FOLD,
} from "../src/mechanisms/pressure/index.js";
import { PEOPLE_ALL } from "../src/mechanisms/pressure/people.js";
import { type ChatNode, emptyWorld, type World } from "../src/mechanisms/pressure/world.js";
import { allMechanisms, mechanisms, productionMechanisms } from "../src/mechanisms/registry.js";
import type { Act } from "../src/mind/affordances.js";
import type { Composition, Part } from "../src/mind/compose.js";
import type { PonderRequest, SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent, Ponder, SpeechDecision } from "../src/mind/events.js";
import { composeMind, type Mechanism } from "../src/mind/mechanism.js";
import { NOISE_EVERY_MS } from "../src/mind/noise.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { step } from "../src/mind/step.js";
import { replay } from "../src/sim/replay.js";
import { arms } from "../src/sim/will-arms.js";

const ARMS = arms({});
const pressureOf = (list: readonly Mechanism[]) =>
  list.flatMap((m) => {
    const c = compositionOf(m);
    return c ? [{ m, c }] : [];
  })[0];

/** 一种组成的读数写成短句，方便逐条比较。 */
function summary(c: Composition<Part<Slice>, Slice>) {
  return {
    inactive: c.inactive.map((i) => `${i.part} 缺 ${i.missing.join("、")}`),
    gaps: c.gaps.map((g) => `${g.part} 读 ${g.key}，没有提供者`),
    shared: c.shared.map((s) => `${s.part} 也写 ${s.key}（${s.owner ?? "没有提供者"}）`),
  };
}

const production = summary(partsOf(PRODUCTION));

describe("production: one concept, one owner", () => {
  it("every slice read in production has a production writer", () => {
    expect(production.gaps).toEqual([]);
  });

  it("the only inactive parts are will-layer terms whose feature is not in production", () => {
    expect(production.inactive).toEqual([]);
  });

  it("has zero shared dual-writers in production now that memory owns chats.commitments", () => {
    expect(production.shared).toEqual([]);
  });

  it("about people lives in one record: relation owns relations, the world base no longer provides contacts or closeness", () => {
    const c = partsOf(PRODUCTION);
    expect(c.providers.get("relations")).toBe("relation-tier");
    expect(WORLD_FOLD.provides).not.toContain("contacts");
    expect(WORLD_FOLD.provides).not.toContain("closeness");
    // "想过、决定先不找他"是意愿层自己的结局，留在世界底座。
    expect(WORLD_FOLD.provides).toContain("willingness");
  });

  it("familiar keeps no fold of its own: its state is the same person geometry as relations", () => {
    // 看见的事实（第一次看见、有往来的日子、群里的入群提示、机器人标记）只有一份几何；familiar 只是按同一套
    // 折叠函数折自己那份（机制之间不读彼此的状态），所以两边是同一组字段。
    expect(Object.keys(familiar.initial as object).sort()).toEqual([
      "groups",
      "partners",
      "people",
    ]);
    expect(Object.keys(emptyWorld.relations).sort()).toEqual(
      expect.arrayContaining(["groups", "people"]),
    );
  });

  it("the registry's pressure field is the production composition", () => {
    expect(summary(compositionOf(pressureProduction) as Composition<Part<Slice>, Slice>)).toEqual(
      production,
    );
  });
});

describe("the mind's mechanisms", () => {
  it("production composes with every mechanism active when the shell runs the executor", () => {
    const c = composeMind(mechanisms, ["errand"]);
    expect(c.inactive).toEqual([]);
    expect(c.mechanisms).toEqual(mechanisms);
    expect(productionMechanisms(true)).toEqual(mechanisms);
  });

  it("without the executor errands is inactive and says what it misses", () => {
    const c = composeMind(mechanisms, []);
    expect(c.inactive).toEqual([{ part: "errands", missing: ["errand"] }]);
    expect(productionMechanisms(false)).toEqual(mechanisms.filter((m) => m !== errands));
  });
});

/** 每个组别和生产不同的地方（生产本身见上）。 */
const gap = (part: string, key: string) => `${part} 读 ${key}，没有提供者`;
/** 群里份额那一笔看有没有在别处答应、来这里做的事（turn.ts shareCost）；没有记忆时没有这样的事。 */
const NO_MEMORY = {
  inactive: ["drive.commitments 缺 chats.commitments"],
  gaps: [gap("dwell-look-share-rejection", "chats.commitments")],
  shared: [],
};
const DWELL_GAP = gap("thought-conversation-carry", "chats.turn.dwell");
const REJECTION_GAP = gap("affect-warm-tone-rejection", "chats.turn.rejection");
const FAIRNESS_REJECTION_GAP = gap("fairness", "chats.turn.rejection");
const SHARE = "drive.share 缺 posts";
const ARM_DIFFERENCES: Record<string, ReturnType<typeof summary>> = {
  groupturn: {
    inactive: [],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP],
    shared: [],
  },
  "groupturn-no-topic": {
    inactive: ["drive.topic 缺 chats.turn.topic"],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP],
    shared: [],
  },
  "groupturn-no-bond": {
    inactive: ["drive.bond 缺 chats.turn.bond"],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP],
    shared: [],
  },
  "groupturn-no-floor": {
    inactive: [],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP],
    shared: [],
  },
  floor: {
    inactive: [],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP],
    shared: [],
  },
  "no-floor": {
    inactive: [],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP],
    shared: [],
  },
  "floor-wake": {
    inactive: [],
    gaps: [FAIRNESS_REJECTION_GAP, DWELL_GAP, REJECTION_GAP, gap("floorwake", "chats.turn.leftAt")],
    shared: [],
  },
  "no-people": {
    inactive: [],
    gaps: [gap("memory", "facts"), gap("recall-tools", "facts"), gap("group-pull", "facts")],
    shared: [],
  },
  "no-affect": {
    inactive: [],
    gaps: [gap("reflect", "affect"), gap("life-body-l2", "affect"), gap("positive-loop", "affect")],
    shared: [],
  },
  "no-desire": {
    inactive: [SHARE],
    gaps: [gap("positive-loop", "posts")],
    shared: [],
  },
  "no-diary": {
    inactive: [],
    gaps: [gap("recall-tools", "diary"), gap("group-pull", "diary")],
    shared: [],
  },
  "no-inner": {
    inactive: [],
    gaps: [gap("recall-tools", "thoughts")],
    shared: [],
  },
  "no-life": {
    inactive: [],
    gaps: [
      gap("recall-tools", "life"),
      gap("positive-loop", "life"),
      gap("affect-warm-tone-rejection", "life"),
    ],
    shared: [],
  },
  "no-reach": {
    inactive: ["drive.information 缺 reach", "drive.place 缺 chats.place"],
    gaps: [],
    shared: [],
  },
  "telegram-only": {
    inactive: [],
    gaps: [
      gap("recall-tools", "life"),
      gap("positive-loop", "life"),
      gap("affect-warm-tone-rejection", "life"),
    ],
    shared: [],
  },
};

describe("every arm composes without silent gaps", () => {
  it("each arm's mechanisms compose with the replay's executor", () => {
    for (const [name, list] of Object.entries(ARMS)) {
      expect(composeMind(list, ["errand"]).inactive, name).toEqual([]);
    }
  });

  it("each arm's pressure field lists its inactive parts and gaps", () => {
    const seen: Record<string, ReturnType<typeof summary>> = {};
    for (const [name, list] of Object.entries(ARMS)) {
      const p = pressureOf(list);
      if (!p) continue;
      const s = summary(p.c);
      if (JSON.stringify(s) !== JSON.stringify(production)) seen[name] = s;
    }
    expect(seen).toEqual(ARM_DIFFERENCES);
  });

  it("every arm has a pressure field", () => {
    const without = Object.entries(ARMS).flatMap(([name, list]) =>
      pressureOf(list) ? [] : [name],
    );
    expect(without).toEqual([]);
  });
});

describe("removing a provider", () => {
  it("makes the will-layer term that reads it inactive, and the test can see it", () => {
    expect(summary(partsOf({ ...PRODUCTION, memory: undefined }))).toEqual(NO_MEMORY);
  });

  it("puts it back when the provider returns", () => {
    expect(summary(partsOf({ ...PRODUCTION, memory }))).toEqual(production);
  });

  it("two providers of one slice cannot compose", () => {
    const twin = { ...people(PEOPLE_ALL), name: "people-twin", provides: ["chats.commitments"] };
    expect(() => partsOf({ ...PRODUCTION, people: twin as never })).toThrow(/chats\.commitments/);
  });
});

// ── 写入审计 ─────────────────────────────────────────────────────────

/** 会话字段归谁：没列出的都是世界折叠的核心字段（chats）。 */
const CHAT_FIELDS: Partial<Record<keyof ChatNode, ChatSlice>> = {
  commitments: "chats.commitments",
  topics: "chats.topics",
  place: "chats.place",
};
const TURN_FIELDS: Record<string, ChatSlice> = {
  topic: "chats.turn.topic",
  topicAt: "chats.turn.topic",
  recent: "chats.turn.topic",
  bond: "chats.turn.bond",
  bondAt: "chats.turn.bond",
  leftAt: "chats.turn.leftAt",
  dwell: "chats.turn.dwell",
  watch: "chats.turn.watch",
};

/** 一步折叠改了哪几块（按引用比较：没改的块原样带过去）。 */
function written(before: World, after: World): Set<Slice> {
  const out = new Set<Slice>();
  if (before === after) return out;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof World>;
  for (const k of keys) {
    if (before[k] === after[k]) continue;
    if (k !== "chats") {
      out.add(k);
      continue;
    }
    for (const s of new Set([...Object.keys(before.chats), ...Object.keys(after.chats)])) {
      const a = before.chats[s];
      const b = after.chats[s];
      if (a === b) continue;
      if (!a || !b) {
        out.add("chats");
        continue;
      }
      for (const f of Object.keys(b) as Array<keyof ChatNode>) {
        if (a[f] === b[f]) continue;
        if (f !== "turn") {
          out.add(CHAT_FIELDS[f] ?? "chats");
          continue;
        }
        for (const t of Object.keys(b.turn) as Array<keyof ChatNode["turn"]>) {
          if (a.turn[t] !== b.turn[t]) out.add(TURN_FIELDS[t] ?? "chats");
        }
      }
    }
  }
  return out;
}

const declared = (p: Part<Slice>) =>
  p.provides !== undefined ||
  p.requires !== undefined ||
  p.uses !== undefined ||
  p.amends !== undefined;

/** 桩：每次都开口，给得了的心里的能力都用上一点，隔几次不说话。 */
function speech(): (r: SpeechRequest) => SpeechDecision {
  let n = 0;
  return (r) => {
    n++;
    if (n % 5 === 0) return { acts: [] };
    const has = (k: Act["kind"]) => r.affordances.includes(k);
    const acts: Act[] = [];
    if (has("think")) acts.push({ kind: "think", thought: "先想一想" });
    acts.push({ kind: "send", text: "嗯嗯 好呀", replyTo: null });
    if (has("feel")) acts.push({ kind: "feel", mood: "开心", why: "有人找我" });
    if (has("intend") && n % 3 === 1) {
      acts.push({ kind: "intend", when: "10分钟后", what: "去散步" });
    }
    if (has("fulfil") && n % 3 === 2) acts.push({ kind: "fulfil", what: "去散步" });
    if (has("diary")) acts.push({ kind: "diary", about: null, entry: "今天聊得挺开心" });
    if (has("topic-open") && n % 4 === 1) acts.push({ kind: "topic-open", title: "露营" });
    if (has("bed") && n % 4 === 2) acts.push({ kind: "bed" });
    return { acts };
  };
}

/** 她自己的生活和心情的起伏（外壳每 5 分钟抽一次）：固定的数，回放确定。 */
function withNoise(events: readonly AliceEvent[]): AliceEvent[] {
  const first = events[0]?.at ?? 0;
  const last = events.at(-1)?.at ?? 0;
  const noise: AliceEvent[] = [];
  for (let at = first, i = 0; at <= last; at += NOISE_EVERY_MS, i++) {
    const z = Math.sin(i + 1);
    noise.push({
      type: "noise.drawn",
      at,
      scope: "self",
      draws: { mood: z, energy: -z, social: z / 2, life: Math.abs(z), "life-length": z },
    });
  }
  return [...events, ...noise].sort((a, b) => a.at - b.at);
}

function ponder(r: PonderRequest): Ponder {
  if (r.kind === "life") {
    return { kind: "life", date: r.date, activities: {}, moments: [], ongoing: [] };
  }
  const who = r.people[0]?.id;
  return {
    kind: "reflect",
    scope: r.scope,
    entries: [{ about: null, text: "今天和大家聊得挺开心", importance: 6 }],
    mood: { word: "开心", why: "大家都在" },
    learned: {
      ...(who
        ? { facts: [{ about: who, said: "露营", text: "喜欢露营", when: null, replaces: null }] }
        : {}),
      self: [{ said: "喜欢露营", text: "我也喜欢露营", replaces: null }],
    },
  };
}

const SCENES = [
  "scenes/synthetic-v1/d08-camping-group/events.jsonl",
  "scenes/synthetic-v2/fam-02-old-friend-dm/events.jsonl",
];
const hasScenes = SCENES.every((p) => existsSync(p));
const scene = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AliceEvent);

/**
 * 在场景上真跑一遍（桩），再把她经历的事件按这种组成折一遍，记下每一步写了哪几块（seen）、声明里没有的（bad）。
 */
async function audit(list: readonly Mechanism[]): Promise<{ bad: string[]; seen: string[] }> {
  const p = pressureOf(list);
  if (!p) return { bad: [], seen: [] };
  const parts = new Map<string, Part<Slice>>([
    [WORLD_FOLD.name, WORLD_FOLD],
    ...p.c.active.map((x) => [x.name, x] as const),
  ]);
  const bad = new Set<string>();
  const seen = new Set<string>();
  for (const path of SCENES) {
    const events: AliceEvent[] = [];
    await replay(withNoise(scene(path)), {
      mechanisms: list,
      speech: speech(),
      ponder,
      tickMs: 60_000,
      observe: (e) => events.push(e),
    });
    const fold = auditedFold(p.m, (name, before, after) => {
      const part = parts.get(name);
      if (!part || !declared(part)) return;
      const allowed = new Set([...(part.provides ?? []), ...(part.amends ?? [])]);
      for (const k of written(before, after)) {
        seen.add(`${name} ${k}`);
        if (!allowed.has(k)) bad.add(`${name} 写了 ${k}`);
      }
    });
    events.reduce(fold, emptyWorld);
  }
  return { bad: [...bad].sort(), seen: [...seen].sort() };
}

describe.skipIf(!hasScenes)("write audit", () => {
  // 同一种压力场组成只审一次。
  const distinct = new Map<string, readonly Mechanism[]>();
  for (const list of Object.values(ARMS)) {
    const p = pressureOf(list);
    if (p && !distinct.has(p.m.name)) distinct.set(p.m.name, list);
  }

  for (const [name, list] of distinct) {
    it(`${name}: each declared part writes only what it declares`, async () => {
      expect((await audit(list)).bad).toEqual([]);
    }, 30_000);
  }

  it("the production run writes every production slice, so the audit sees each writer", async () => {
    // 写入审计只在真写了的时候看得见。两个场景都不在夜里，她不会选 [去睡了]，bedAt 写不到。
    const c = partsOf(PRODUCTION);
    const writers = [
      ...[...c.providers].map(([k, part]) => `${part} ${k}`),
      ...c.shared.map((s) => `${s.part} ${s.key}`),
    ];
    const { seen } = await audit(ARMS.production as readonly Mechanism[]);
    // 两个场景里也没有人嫌她（没有口气记录），也没有搜群预览，这两块写不到。
    expect(writers.filter((w) => !seen.includes(w))).toEqual([
      "dwell-look-share-rejection chats.turn.rejection",
      "reach chats.place",
    ]);
  }, 30_000);

  it("the audit sees an undeclared write", () => {
    const before = emptyWorld;
    const after = { ...before, diary: [] };
    expect([...written(before, after)]).toEqual(["diary"]);
    const chat = { ...(emptyWorld as World), chats: {} };
    expect(written(chat, chat).size).toBe(0);
  });
});

describe("typed views", () => {
  it("reading a slice the feature did not declare is a type error", () => {
    const f = feature({
      name: "probe",
      requires: ["chats"],
      contribute: ({ world, chat }) => {
        // @ts-expect-error affect 没有声明，看不见（去掉这一行的注释 tsc 就报错）
        const mood = world.affect;
        return mood === undefined && world.chats[chat.scope] === undefined ? [] : [];
      },
    });
    expect(f.requires).toEqual(["chats"]);
  });
});

describe("declarations cover everything", () => {
  it("every part of every arm's pressure field declares what it writes and reads", () => {
    const undeclared = Object.values(ARMS).flatMap((list) => {
      const p = pressureOf(list);
      return p ? p.c.active.filter((x) => !declared(x)).map((x) => x.name) : [];
    });
    expect([...new Set(undeclared)]).toEqual([]);
  });

  it("every slice of the world has a provider among the parts we have", () => {
    const provided = new Set<string>(WORLD_FOLD.provides);
    for (const list of Object.values(ARMS)) {
      for (const k of pressureOf(list)?.c.providers.keys() ?? []) provided.add(k);
    }
    // bedAt 和 missed 是可以没有的字段（组成里没有那一样时世界里没有这一项）。
    const slices = [...Object.keys(emptyWorld), "bedAt", "missed"];
    expect(slices.filter((k) => !provided.has(k))).toEqual([]);
  });

  it("every mechanism in allMechanisms composes with unique state and no shared action providers", () => {
    const c = composeMind(allMechanisms, ["errand"]);
    expect(c.inactive).toEqual([]);
    expect(c.shared).toEqual([]);
  });

  it("language ignores channel posts and flagged bots (PLAN item 19)", () => {
    const s1 = step(
      emptyState,
      {
        type: "post.received",
        at: 1_771_000_000_000,
        scope: "telegram:-10099",
        messageId: "p1",
        title: "English News",
        text: "Breaking quantum computing news today in English",
      },
      [language],
    ).state;
    expect(Object.keys(s1.chats)).toEqual([]);
    const chat = emptyChat("telegram:-1", "group", true);
    const withBot = step(
      emptyState,
      {
        type: "message.received",
        at: 1_771_000_000_000,
        scope: "telegram:-1",
        chatType: "group",
        messageId: "m1",
        senderId: "bot1",
        senderName: "Rose",
        isBot: true,
        text: "Hello everyone, please read the rules",
        contentType: "text",
        replyToMessageId: null,
        directed: false,
      },
      [language],
    ).state;
    expect(
      language.contribute?.(withBot.chats["telegram:-1"] ?? chat, 1_771_000_000_000, undefined, []),
    ).toEqual([]);
  });
});
