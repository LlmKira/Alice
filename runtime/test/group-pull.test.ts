/**
 * 群里的拉力（mechanisms/pressure/group-pull.ts）：跨会话 idf 把填充词压到 0，把少见的话题词留住；
 * 交情在熟人说话时起来、按 24 小时半衰期平滑淡掉。
 */
import { describe, expect, it } from "vitest";
import {
  bondPull,
  type ChatTermFreqs,
  crossChatDocFreqs,
  crossChatIdf,
  groupPull,
  topicSalience,
} from "../src/mechanisms/pressure/group-pull.js";
import type { Relation } from "../src/mechanisms/pressure/relation.js";
import { BOND_HALF_LIFE, tokens } from "../src/mechanisms/pressure/turn.js";
import { emptyWorld, freshChat, type World } from "../src/mechanisms/pressure/world.js";
import type { MessageReceived } from "../src/mind/events.js";

const G = "telegram:-7";
const DM = "telegram:7";
const C = "contact:7";
const T0 = 1_771_000_000_000;

function received(
  at: number,
  scope: string,
  chatType: "private" | "group",
  text: string,
): MessageReceived {
  return {
    type: "message.received",
    at,
    scope,
    chatType,
    messageId: `m${at}`,
    senderId: C,
    senderName: "阿凯",
    text,
    contentType: "text",
    replyToMessageId: null,
    directed: false,
  };
}

const termFreqs = (text: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of tokens(text)) out[t] = (out[t] ?? 0) + 1;
  return out;
};

/** 四个会话的最近词频：每个群/私聊都在说"知道不是这个"，另外各有自己的事。 */
const CHATS: ChatTermFreqs = {
  "telegram:1": termFreqs("我知道不是这个意思，晚上吃什么"),
  "telegram:2": termFreqs("你知道不是这个吗，吉他练得怎样"),
  "telegram:3": termFreqs("我知道不是这个怎么办，还在加班"),
  "telegram:-8": termFreqs("知道不是这个就好，明天见"),
};

/** 她心里记得的：填充词 + 两件具体的事。 */
const MEMORY = [tokens("她知道不是这个，最近在看芙莉莲，周末去露营")];

describe("crossChatIdf: filler has no weight, a rare topic word does", () => {
  it("gives words that every chat uses an idf of 0", () => {
    const idf = crossChatIdf(tokens("我知道不是这个 芙莉莲"), CHATS, MEMORY);
    for (const filler of ["知道", "不是", "这个"]) expect(idf[filler] ?? 0).toBe(0);
    // "芙莉" 只在她的记忆里出现（单个文档），权重接近 ln(文档数)。
    const { totalDocs } = crossChatDocFreqs(CHATS, MEMORY);
    expect(idf.芙莉 ?? 0).toBeGreaterThan(Math.log(totalDocs) * 0.99);
  });
});

describe("topicSalience: what pulls her is the topic, not the filler", () => {
  const { df, totalDocs } = crossChatDocFreqs(CHATS, MEMORY);

  it("scores a sentence made of shared function words at about zero", () => {
    expect(topicSalience("我知道不是这个", MEMORY, df, totalDocs)).toBeLessThan(0.05);
    expect(topicSalience("你知道不是这个吗", MEMORY, df, totalDocs)).toBeLessThan(0.05);
  });

  it("scores a sentence matching her memories high", () => {
    expect(topicSalience("最近在看芙莉莲", MEMORY, df, totalDocs)).toBeGreaterThan(0.5);
    expect(topicSalience("周末去露营", MEMORY, df, totalDocs)).toBeGreaterThan(0.5);
  });

  it("does not invent salience for something she has never heard", () => {
    expect(topicSalience("量子色动力学", MEMORY, df, totalDocs)).toBe(0);
  });

  it("does not let empty chats or empty memories stretch the corpus", () => {
    const docs = crossChatDocFreqs({ ...CHATS, "telegram:99": {} }, [...MEMORY, []]);
    expect(docs.totalDocs).toBe(totalDocs);
    expect(topicSalience("最近在看芙莉莲", [...MEMORY, []], docs.df, docs.totalDocs)).toBeCloseTo(
      topicSalience("最近在看芙莉莲", MEMORY, df, totalDocs),
      10,
    );
  });
});

describe("bondPull: a bonded friend speaks, the pull decays smoothly", () => {
  const person = (lastBondAt: number) => ({ lastBondAt });
  /** 世界里的那一条记录：他回应过她（lastBondAt 为 0 时还没有）。 */
  const bond = (lastBondAt: number): Relation => ({
    name: "阿凯",
    bot: false,
    seen: {
      firstAt: T0,
      lastAt: T0,
      count: 0,
      toHerDays: [],
      lastToHerAt: lastBondAt,
      lastAnswerAt: lastBondAt,
      theirs: 0,
      hers: 0,
      herAt: -Infinity,
      rooms: {},
    },
    warmth: {
      score: 0,
      scoreAt: 0,
      lastExchangeAt: 0,
      firstAt: 0,
      opened: null,
      exchanges: 0,
    },
    hurts: [],
  });

  it("adds a fresh pull when the bond just happened and halves at each half-life", () => {
    expect(bondPull(person(T0), 0, T0)).toBeCloseTo(1, 6);
    expect(bondPull(person(T0), 0, T0 + BOND_HALF_LIFE)).toBeCloseTo(0.5, 6);
    expect(bondPull(person(T0), 0, T0 + 2 * BOND_HALF_LIFE)).toBeCloseTo(0.25, 6);
    expect(bondPull(person(T0), 0, T0 + 4 * BOND_HALF_LIFE)).toBeCloseTo(0.0625, 6);
  });

  it("keeps what was already there and does nothing for a stranger", () => {
    expect(bondPull(person(T0), 0.4, T0 + BOND_HALF_LIFE)).toBeCloseTo(0.9, 6);
    expect(bondPull(person(0), 0.3, T0)).toBe(0.3);
    expect(bondPull(undefined, 0.3, T0)).toBe(0.3);
  });

  it("wakes the group's bond signal through groupPull's reducer", () => {
    const reduce = groupPull.reduce;
    if (!reduce) throw new Error("groupPull has no reducer");
    const chat = freshChat("group");
    const world: World = {
      ...emptyWorld,
      chats: { [G]: chat },
      relations: { people: { [C]: bond(T0) }, groups: {}, waiting: {} },
    };
    const at = T0 + BOND_HALF_LIFE;
    const event = received(at, G, "group", "今天去露营吗");
    const after = reduce(world, world, event);
    expect(after.chats[G]?.turn.bond).toBeCloseTo(0.5, 6);
    expect(after.chats[G]?.turn.bondAt).toBe(at);

    // 没有交情的人说话，拉力不动。
    const strangerWorld: World = {
      ...world,
      relations: { ...world.relations, people: { [C]: bond(0) } },
    };
    const stranger = reduce(strangerWorld, strangerWorld, event);
    expect(stranger.chats[G]?.turn.bond).toBe(0);
  });
});

describe("groupPull: the topic signal", () => {
  it("pulls her toward a group message that matches what she remembers", () => {
    const reduce = groupPull.reduce;
    if (!reduce) throw new Error("groupPull has no reducer");
    const privateChat = freshChat("private");
    const world: World = {
      ...emptyWorld,
      chats: {
        [G]: freshChat("group"),
        [DM]: { ...privateChat, turn: { ...privateChat.turn, recent: [tokens("今天吃什么")] } },
      },
      said: [{ at: T0, scope: DM, text: "最近在看芙莉莲" }],
    };
    const after = reduce(world, world, received(T0, G, "group", "最近在看芙莉莲"));
    expect(after.chats[G]?.turn.topic).toBeGreaterThan(0.9);
    expect(after.chats[G]?.turn.topicAt).toBe(T0);
  });
});

describe("groupPull: the cross-chat corpus", () => {
  it("records private-chat words without treating them as a pull", () => {
    const reduce = groupPull.reduce;
    if (!reduce) throw new Error("groupPull has no reducer");
    const world: World = { ...emptyWorld, chats: { [DM]: freshChat("private") } };
    const after = reduce(world, world, received(T0, DM, "private", "我知道不是这个"));
    expect(after.chats[DM]?.turn.recent).toHaveLength(1);
    expect(after.chats[DM]?.turn.topic).toBe(0);
    expect(after.chats[DM]?.turn.bond).toBe(0);
  });
});
