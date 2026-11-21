import type { Act, ActKind } from "../mind/affordances.js";
import type { ChatType } from "../mind/events.js";
import type { Contribution, Mechanism } from "../mind/mechanism.js";
import type { ChatState } from "../mind/state.js";
import { fnv1a as hash } from "./hash.js";
import { POOL, POOL_CHARM, POOL_DIVERSE, RARE } from "./palette-pool.js";

/**
 * 示例的情绪寄存器调色盘（生产，取代 examples；示例本身在 palette-pool.ts）。
 *
 * 为什么：模型从上下文示例里推断"她平时怎么说话"，示例里哪种口气多，输出就往哪种口气塌
 * （Zhao et al. 2021 的多数标签偏差与近因偏差；2 月 ADR-103 的诊断：傲娇占了调色盘的 27%，回复就都是傲娇；
 * 8 月人格照抄示例 19–27%）。所以示例不负责"教她可爱"，只负责把她能用的口气摊开、每种一样多，
 * 此刻用哪种由聊天本身（谁、说了什么、她的心情）去定，而不是由示例的比例去定。
 *
 * 怎么做（分层选择：层间求覆盖，层内求相关，Levy et al. 2023 的覆盖式选择、MMR 取相似度为"同一寄存器"时的极限）：
 * - 每种寄存器至多出现一次。私聊里全部寄存器都在；群里只放 GROUP_SPEAKING 种（另一半是沉默和轻回应的示例，
 *   各占一半），哪几种按会话和日子轮换，所以长期看也是均匀的。
 * - 同一寄存器里挑和最近聊天字面上最接近的一条（KATE 式的相关度，这里只用字的二元组，纯函数）。
 * - 输出顺序按会话和日子打散，没有哪种口气总排在最后（近因偏差）。
 * - 她自己说过的话不当示例（2026-11-13 起；以前记心情时说的话会替换那种口气的示例，她越说越像自己：俄语群的参考里
 *   一半是她自己的长句。docs/adr/282-speech-style-and-room-voice.md）。
 * - 发语音、改刚发的消息、跟着复读、算了不追究、翻相册这五样，这一轮给了她才把示范放进来（palette-pool.ts RARE），
 *   不参加轮换：轮换会把它们抽掉，她就一直看不到（线上这五样一次都没用过）。
 */

export const REGISTERS = [
  "温柔",
  "撒娇",
  "嘴硬",
  "逗人",
  "认真",
  "关心",
  "委屈",
  "兴奋",
  "平淡",
  "有主见",
  "害羞",
  /** 她说起自己那边的事（context-v2 加的一种）。 */
  "分享",
] as const;
export type Register = (typeof REGISTERS)[number];

/** 一条示例：场景和她那一刻的决定（动作序列，发言层用 codeMode.render 写出来）。 */
export interface Example {
  register: Register;
  chat: ChatType;
  scene: string;
  acts: Act[];
  /** old：旧示例里保留的（群里沉默的那几条）；context：palette-pool.ts 的那套（context-v2）。 */
  source: "old" | "context";
}

/** 这一轮给了她 needs 才放进参考的示范（palette-pool.ts RARE）。 */
export interface RareExample {
  needs: ActKind;
  scene: string;
  acts: Act[];
  code?: string;
}

/** 示例里她说出口的话（每条 say 一句）。 */
export const said = (acts: readonly Act[]): string[] =>
  acts.flatMap((a) => (a.kind === "send" ? [a.text] : []));

const G = (register: Register, scene: string, acts: Act[] = []): Example => ({
  register,
  chat: "group",
  scene,
  acts,
  source: "old",
});

/**
 * 群里沉默和轻回应的示例（不说话、只发贴纸、只点表情）：和开口的示例各占一半，不随调色盘变。
 * 只点表情那条是 2026-11-13 加的（Gemini 改稿 3B，docs/adr/282-speech-style-and-room-voice.md）。
 */
export const GROUP_SILENT: readonly Example[] = [
  G("平淡", "大家在聊一个你没玩过的游戏"),
  G("平淡", "有人问一件你不太确定的事，另一个更懂的人在线"),
  G("平淡", "你刚刚已经连着说了三条"),
  G("平淡", "大家在激烈争论，你还没看明白"),
  G("逗人", "有人讲了个很好笑的事", [{ kind: "sticker", word: "laugh" }]),
  G("逗人", "有人发了一张离谱梗图，大家在刷哈哈", [
    { kind: "react", messageId: "27", emoji: "🤣" },
  ]),
];

/** 私聊里的轻回应与沉默示范：在私聊里也看得见贴纸、表情和停手，不再只有纯打字示例。 */
export const PRIVATE_LIGHT: readonly Example[] = [
  {
    register: "平淡",
    chat: "private",
    scene: "对方累了只回了一个「哦」或「1」",
    acts: [{ kind: "sticker", word: "hug" }],
    source: "context",
  },
  {
    register: "逗人",
    chat: "private",
    scene: "对方发来一张离谱梗图逗你",
    acts: [{ kind: "react", messageId: "18", emoji: "🤣" }],
    source: "context",
  },
  {
    register: "平淡",
    chat: "private",
    scene: "你刚才已经连着发了两条，对方还没接上来",
    acts: [],
    source: "context",
  },
];

/** 群里同时放几种开口的寄存器（另有同样多的沉默和轻回应示例）。 */
export const GROUP_SPEAKING = GROUP_SILENT.length;

const DAY_MS = 24 * 60 * 60_000;
const ROTATION_WINDOW_MS = 15 * 60_000;
const CN_OFFSET_MS = 8 * 60 * 60_000;

function bigrams(s: string): Set<string> {
  const chars = [...s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")];
  const out = new Set<string>();
  chars.slice(1).forEach((c, i) => {
    out.add(`${chars[i]}${c}`);
  });
  return out;
}

/** 示例里的字有多少出现在最近的聊天里（0–1）。 */
function relevance(e: Example, recent: Set<string>): number {
  const own = bigrams(`${e.scene}${said(e.acts).join("")}`);
  if (own.size === 0) return 0;
  let hit = 0;
  for (const b of own) if (recent.has(b)) hit++;
  return hit / own.size;
}

/** 最近几条聊天，算相关度用。 */
const RECENT = 10;
const PRUNE_ACTIVE_TIMELINE = 10;

export interface PaletteOptions {
  /** 按 calls + 15 分钟窗口轮换（替代按天锁死）。 */
  perCall?: boolean;
  /** 跳过字面二元组相关度排序，防止常见词把同一条示例锁在第一位。 */
  noRelevance?: boolean;
  /** 群聊已经活跃（timeline >= 10）时剪掉 6 条开口示范，只保留沉默/轻回应与少用动作示范（APP）。 */
  pruneActive?: boolean;
  /** 私聊补入贴纸、点表情与停手的轻回应示范（并按 offered 过滤），避免私聊只有纯打字示例。 */
  privateLight?: boolean;
  /** 私聊里最多轮换保留几条日常开口示范（不传则全留，保持生产不变）。 */
  privateSlots?: number;
}

function pick(
  chat: ChatState,
  now: number,
  examples: readonly Example[],
  offered: readonly ActKind[],
  options: PaletteOptions = {},
): Array<{ scene: string; acts: Act[]; code?: string }> {
  const key = options.perCall
    ? `${chat.scope}|${chat.calls}|${Math.floor(now / ROTATION_WINDOW_MS)}`
    : `${chat.scope}|${Math.floor((now + CN_OFFSET_MS) / DAY_MS)}`;
  const pool = examples.filter((e) => e.chat === chat.chatType);
  const recent = options.noRelevance
    ? new Set<string>()
    : bigrams(
        chat.timeline
          .slice(-RECENT)
          .map((t) => t.text ?? "")
          .join(""),
      );
  const ranked = (register: Register): Example[] =>
    pool
      .filter((e) => e.register === register)
      .map((e) => ({
        e,
        r: options.noRelevance ? 0 : relevance(e, recent),
        h: hash(`${key}|${e.scene}`),
      }))
      .sort((a, b) => b.r - a.r || b.h - a.h)
      .map((x) => x.e);
  const rotation = REGISTERS.filter((r) => pool.some((e) => e.register === r)).sort(
    (a, b) => hash(`${key}|${a}`) - hash(`${key}|${b}`),
  );
  const pruneGroup =
    options.pruneActive === true &&
    chat.chatType === "group" &&
    chat.timeline.length >= PRUNE_ACTIVE_TIMELINE;
  const slots =
    chat.chatType === "private" ? (options.privateSlots ?? rotation.length) : GROUP_SPEAKING;
  const chosen = pruneGroup ? [] : rotation.slice(0, slots).flatMap((r) => ranked(r).slice(0, 1));
  const rare: Array<{ scene: string; acts: Act[]; code?: string }> = RARE.filter((e) =>
    offered.includes(e.needs),
  ).map((e) => ({ scene: e.scene, acts: e.acts, ...(e.code ? { code: e.code } : {}) }));
  const privateLight =
    options.privateLight === true && chat.chatType === "private"
      ? PRIVATE_LIGHT.filter((e) => e.acts.every((a) => offered.includes(a.kind)))
      : [];
  const all: Array<{ scene: string; acts: Act[]; code?: string }> = [
    ...chosen,
    ...(chat.chatType === "group" ? GROUP_SILENT : privateLight),
    ...rare,
  ];
  return all
    .map((e) => ({ e, h: hash(`${key}|order|${e.scene}`) }))
    .map(({ e }) => ({ scene: e.scene, acts: e.acts, ...(e.code ? { code: e.code } : {}) }));
}

/** 一套示例的调色盘：同一份挑法，示例池由调用方给。 */
export function createPalette(
  examples: readonly Example[],
  options: PaletteOptions = {},
): Mechanism {
  return {
    name: "palette",
    contribute: (chat, now, _state, offered): Contribution[] => [
      {
        mechanism: "palette",
        kind: "reference",
        text: `你平时${chat.chatType === "group" ? "在群里" : "私聊时"}的几种回法`,
        examples: pick(chat, now, examples, offered, options),
      },
    ],
  };
}

/**
 * 生产：palette-pool.ts 的示例（context-v2；2026-11-13 Gemini 改稿 3 改写，docs/adr/282-speech-style-and-room-voice.md），
 * 加上这一轮给了她的那几样少用动作的示范。示例是决定（动作序列），由发言层按所用的动作格式写出来，所以示例和
 * 输出永远是同一种写法。
 */
export const palette: Mechanism = createPalette(POOL);

/**
 * 候选（out-charm.md 改法 3B，eval-artifacts/charm/）：换掉那六个偏平的示范、加三段有脑洞/小账本/骨气的示例。
 * 生产 palette 与 POOL 都不动。
 */
export const paletteCharm: Mechanism = createPalette(POOL_CHARM);

/** 候选（diversity 消融）：扩充去口癖群聊池 + 按调用与 15 分钟窗轮换 + 取消字面锁死。 */
export const paletteDiverse: Mechanism = createPalette(POOL_DIVERSE, {
  perCall: true,
  noRelevance: true,
});

/** 候选（复合精简示范）：活跃群剪开口、私聊缩槽位并补入贴纸/表情/停手示范，兼顾非文字动作覆盖与 token 瘦身。 */
export const paletteComposite: Mechanism = createPalette(POOL, {
  pruneActive: true,
  privateLight: true,
  privateSlots: 4,
});
