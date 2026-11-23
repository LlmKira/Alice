/**
 * 只往提示词里写她自己的几样东西（不碰驱动）：内心独白、行动回声、能力事实。
 * 各是压力场的一样（feature.ts），读世界里她自己写下的东西。
 */
import type { Contribution } from "../../mind/mechanism.js";
import { crossPlatformTag, platformLabel } from "../../mind/platform.js";
import { type ChatState, SEGMENT_GAP_MS } from "../../mind/state.js";
import { audienceOf, diaryAgo, type EchoOptions, echoText, reaches, relevance } from "./diary.js";
import { feature, type PressureFeature, type View } from "./feature.js";
import { DIARY, THOUGHT, TURN_GAP } from "./params.js";
import { placeOf } from "./place.js";
import { dwellSince } from "./turn.js";
import { presentIn, type ThoughtLine } from "./world.js";

// ── 内心独白（2 月 think()，ADR-117）──────────────────

/**
 * 每一轮可以先在心里想一想（<inner>，不发出去），这个会话里最近 3 条读回给她。每个会话都开。
 * examples：带"第一反应"的示范（INNER_EXAMPLES）。
 * readBack：下一轮读不读回她刚才想过的（消融 inner-no-readback 不读：照样先想后说，只是想过的不再回到提示里；
 * 用来分开"读回负面的想法让下一轮更冷"和"先想后说本身"，eval-artifacts/warmth/prereg.md）。
 * conversation：想过的读回到这段对话结束（记忆流第 1 片，docs/research/memory-stream.md）；不给就是
 * 10 分钟。按对话时每个会话只留最近 THOUGHT.shown 条：更早的那几条在同一段或更早的对话里，
 * 新的还在时轮不到它们。
 * carry（生产，记忆流第 3 片）：别处写下的也带到这里，注明在哪想的（"……在「X」群里想过："）。和日记是同一条
 * （diary.ts reaches）：她写下时标了私密的（[inner] 的 secret）只到写下时在场的人的私聊；其余的哪里都行。写下后
 * DIARY.ttl 之内（2 月日记的 3.3 小时；2/19 峰值从群里带到私聊的就是这样一条），最多 THOUGHT.shown 条。
 * 开着它时也按对话读回。
 */
export function thought(o: {
  examples: boolean;
  readBack?: boolean;
  conversation?: boolean;
  carry?: boolean;
  /** Verbalized Sampling（ICML 2026）：示例展示先在心里闪过 2–3 个不同路子的第一反应再挑最不套话的说。 */
  divergent?: boolean;
  /** 复合示例（去 1-2-3 模板 + 串联 open_topic / feel / sticker / 非套话反应）。 */
  composite?: boolean;
  /** 实验：本会话内想过的直接穿插回聊天时间线原位，不再放进顶部卡片。 */
  inline?: boolean;
  /** 语境完整性（Contextual Integrity）：公开群不带入源自一对一私聊的内心独白。 */
  keepDmInDm?: boolean;
}): PressureFeature {
  const readBack = o.readBack ?? true;
  const carry = o.carry === true;
  const conversation = o.conversation === true || carry;
  const alive: Alive = conversation
    ? stillTalking
    : (_world, _chat, at, now) => now - at <= THOUGHT.window;
  return feature({
    name: `thought${readBack ? "" : "-noreadback"}${conversation ? "-conversation" : ""}${carry ? "-carry" : ""}`,
    provides: ["thoughts"],
    requires: carry ? (["chats", "relations"] as const) : [],
    // 按对话读回时读 dwell 的会话（群里的界线）。没有 dwell 的组成里照常工作，只是群里的想法不再读回
    // （没有她在里面的会话），私聊不受影响，所以是 uses，不是 requires。
    uses: conversation ? (["chats.turn.dwell"] as const) : [],
    affordances: ["think"],
    reduce: (_before, w, event) => {
      if (event.type !== "act.done" || event.act.kind !== "think") return w;
      const text = event.act.thought.trim();
      if (!text) return w;
      const node = w.chats[event.scope];
      const secret = event.act.secret ? { private: true as const } : {};
      // carry：记下写下时在场的人（私聊是对方），带到别处时按它排（diary.ts relevance）。
      const line: ThoughtLine = carry
        ? { at: event.at, scope: event.scope, text, present: presentIn(node), ...secret }
        : { at: event.at, scope: event.scope, text, ...secret };
      if (!conversation) return { ...w, thoughts: [...w.thoughts, line].slice(-THOUGHT.kept) };
      const here = w.thoughts.filter((t) => t.scope === event.scope);
      const drop = new Set(here.slice(0, Math.max(0, here.length + 1 - THOUGHT.shown)));
      return { ...w, thoughts: [...w.thoughts.filter((t) => !drop.has(t)), line] };
    },
    contribute: ({ world, chat, now }) =>
      thoughtLines(
        world,
        chat,
        now,
        o.examples,
        readBack,
        alive,
        carry,
        o.divergent === true,
        o.composite === true,
        o.inline === true,
        o.keepDmInDm === true,
      ),
  });
}
/**
 * 别处写下、此刻带到这里的想法（carry）：写下还不到 DIARY.ttl，按 diary.ts reaches 能到这里的（没标私密的
 * 哪里都行；标了的只到写下时在场的人的私聊）。和此刻在场的人、在聊的话有关系的在前（diary.ts relevance），
 * 一样相关时新的在前，取 THOUGHT.shown 条。
 */
function carriedHere(
  world: View<"thoughts" | "chats">,
  chat: Pick<ChatState, "scope" | "timeline" | "chatType">,
  now: number,
  keepDmInDm = false,
): ThoughtLine[] {
  const here = audienceOf(world, chat.scope, chat);
  return world.thoughts
    .filter((t) => t.scope !== chat.scope && t.at <= now && now - t.at <= DIARY.ttl)
    .map((t) => ({
      t,
      source: {
        scope: t.scope,
        group: world.chats[t.scope]?.chatType === "group",
        present: t.present ?? [],
        text: t.text,
        private: t.private === true,
      },
    }))
    .filter(({ source }) => !(keepDmInDm && chat.chatType === "group" && !source.group))
    .filter(({ source }) => reaches(source, here))
    .map(({ t, source }) => ({ t, r: relevance(source, here) }))
    .sort((a, b) => b.r - a.r || b.t.at - a.t.at)
    .slice(0, THOUGHT.shown)
    .map(({ t }) => t);
}

/** 在 at 写下的想法此刻还读不读回。 */
type Alive = (world: View<"chats.turn.dwell">, chat: ChatState, at: number, now: number) => boolean;

/**
 * 写下这条想法时的那段对话还在不在（第 1 片的界线，用生产已有的）：
 * - 群：她开口后的那段会话（dwell）还开着，想法写在这段会话起始的那一轮或之后。同一轮里先想后说，想法比
 *   开口早一点，所以往前让 TURN_GAP。她只是旁观、没开口，就没有这段会话，想过的不读回。
 * - 私聊：没有 dwell（对方的话本来都冲着她），用"更早的聊天"分段的同一条界线：从想法到现在，相邻两条消息
 *   隔不到 SEGMENT_GAP_MS，最后一条到现在也不到。
 * 对话分线（pressure/threads.ts）进 main 后，两种都换成"写下它的那条线还开着"。
 */
function stillTalking(
  world: View<"chats.turn.dwell">,
  chat: ChatState,
  at: number,
  now: number,
): boolean {
  if (chat.chatType === "group") {
    const node = world.chats[chat.scope];
    const since = node ? dwellSince(node, now) : null;
    return since !== null && at >= since - TURN_GAP;
  }
  const since = segmentSince(chat, now);
  return since !== null && at >= since - TURN_GAP;
}

/**
 * 此刻这一段对话从什么时候开始（相邻两条隔不到 SEGMENT_GAP_MS，和"更早的聊天"分段同一条界线）；已经冷下来
 * 就是 null。私聊的想法读回用它；她自己说过的事在它自己的会话里也按它判断那段对话还在不在（people.ts）。
 */
export function segmentSince(chat: ChatState, now: number): number | null {
  const times = chat.timeline.map((e) => e.at);
  const last = times.at(-1);
  if (last === undefined || now - last > SEGMENT_GAP_MS) return null;
  let i = times.length - 1;
  while (i > 0 && (times[i] as number) - (times[i - 1] as number) <= SEGMENT_GAP_MS) i--;
  const first = times[i] as number;
  // 一直连到记录的第一条：挤出去的那几条在"更早的聊天"里，最后一段和记录接得上就从那一段算起。
  const seg = chat.earlier.at(-1);
  return i === 0 && seg && first - seg.to <= SEGMENT_GAP_MS ? seg.from : first;
}

const clipped = (text: string): string =>
  text.length > THOUGHT.chars ? `${text.slice(0, THOUGHT.chars)}...` : text;

/** 第一反应的示范用哪一套，和 layout 按哪种风格排它。 */
function examplesFor(divergent: boolean, composite: boolean) {
  if (composite) return { examples: INNER_EXAMPLES_COMPOSITE, style: "composite" as const };
  if (divergent) return { examples: INNER_EXAMPLES_VS, style: "vs" as const };
  return { examples: INNER_EXAMPLES, style: undefined };
}

/**
 * 内心独白回写（context-v2）：她在这个会话里刚才心里想过的几条，写成"刚才想过：……"，放进"心里还记着"；
 * 示范是 INNER_EXAMPLES，没有标题（layout 把它们并进参考的回法开头）。
 */
function thoughtLines(
  world: View<"thoughts" | "chats.turn.dwell" | "relations">,
  chat: ChatState,
  now: number,
  withExamples: boolean,
  readBack: boolean,
  alive: Alive,
  carry: boolean,
  divergent = false,
  composite = false,
  inline = false,
  keepDmInDm = false,
): Contribution[] {
  const recent = readBack
    ? world.thoughts
        .filter((t) => t.scope === chat.scope && t.at <= now && alive(world, chat, t.at, now))
        .slice(-THOUGHT.shown)
    : [];
  const carried = readBack && carry ? carriedHere(world, chat, now, keepDmInDm) : [];
  const formatLine = (t: ThoughtLine) =>
    `- ${diaryAgo(now - t.at)}${crossPlatformTag(t.scope, chat.scope)}${t.scope === chat.scope ? "" : placeOf(world, t.scope)}想过：${clipped(t.text)}`;
  const cardLines = inline ? carried : [...carried, ...recent].sort((a, b) => a.at - b.at);
  const text = cardLines.map(formatLine).join("\n");
  const inlineItems = inline
    ? recent.map((t) => ({ at: t.at, text: `(心里) ${clipped(t.text)}` }))
    : [];
  const { examples, style } = examplesFor(divergent, composite);
  return [
    ...(text || inlineItems.length > 0
      ? [
          {
            mechanism: "pressure-thought",
            kind: "thought" as const,
            text,
            ...(inlineItems.length > 0 ? { inline: inlineItems } : {}),
          },
        ]
      : []),
    ...(withExamples
      ? [
          {
            mechanism: "pressure-thought",
            kind: "reference" as const,
            text: "",
            examples,
            ...(style ? { style } : {}),
          },
        ]
      : []),
  ];
}

/**
 * 第一反应的示范。前两条是 Gemini 改稿 3A（2026-11-13：一句一件事，拆成两次 say，不带感叹号；
 * docs/adr/282-speech-style-and-room-voice.md），心里怎么想嘴上就怎么说；后四条是 Gemini 原文 ⑪–⑭
 * （/home/alice/.local/share/alice-briefs/prompt-gemini/out-examples.md 第二节，措辞未改）：心里是真实反应，嘴上拐个弯，
 * 说得嘴硬、俏皮或含蓄，温度不丢。只有前两条时 inner 和 say 说成一样的话，机灵有时吞在 inner 里。
 */
const INNER_EXAMPLES = [
  {
    scene: "聊到你也喜欢的乐队",
    acts: [
      { kind: "think" as const, thought: "诶 他也听这个" },
      { kind: "send" as const, text: "等等你也听他们的", replyTo: null },
      { kind: "send" as const, text: "第三张最好听", replyTo: null },
    ],
  },
  {
    scene: "朋友说这周超累，今天还搞砸了一件事",
    acts: [
      { kind: "think" as const, thought: "听着都替他累 先接住他" },
      { kind: "send" as const, text: "这周太辛苦了", replyTo: null },
      { kind: "send" as const, text: "我在呢 你慢慢说", replyTo: null },
    ],
  },
  {
    scene: "熟人难得夸你今天反应快，其实你心里得意坏了",
    acts: [
      { kind: "think" as const, thought: "终于被发现了吧 忍住不能飘" },
      { kind: "send" as const, text: "一般般", replyTo: null },
      { kind: "send" as const, text: "平时懒得发挥而已", replyTo: null },
    ],
  },
  {
    scene: "很熟的朋友两天没冒泡，突然发来一句「活着呢」",
    acts: [
      { kind: "think" as const, thought: "还以为他失踪了 终于肯冒头" },
      { kind: "send" as const, text: "我还以为你被外星人抓走了", replyTo: null },
      { kind: "send" as const, text: "这两天干嘛去了", replyTo: null },
    ],
  },
  {
    scene: "В чате кто-то уже полчаса спорит о фигне с максимально умным видом",
    acts: [
      { kind: "think" as const, thought: "господи, как же серьезно они это обсуждают" },
      {
        kind: "send" as const,
        text: "вы сейчас реально диссертацию по этому защитите",
        replyTo: null,
      },
    ],
  },
  {
    scene: "说好昨晚一起看剧的人睡过了头，早上才发来一句「睡死了」",
    acts: [
      {
        kind: "think" as const,
        thought: "害我昨晚傻等半天 不过算了谁让他昨晚累成那样",
      },
      { kind: "send" as const, text: "行吧", replyTo: null },
      { kind: "send" as const, text: "欠我一顿夜宵 记账上了", replyTo: null },
    ],
  },
];

/**
 * Verbalized Sampling（Zhang et al., ICML 2026）版本的第一反应示范：先在 inner 里闪过 2–3 个不同方向
 * （顺着接、反着调侃、带出自己的事），跳过最平庸的套话，只把最有意思的那一句说出口。含一条俄语示范防语言串台。
 */
const INNER_EXAMPLES_VS = [
  {
    scene: "群里有人发了张加班到凌晨的工位照片，大家都在刷辛苦了",
    acts: [
      {
        kind: "think" as const,
        thought: "1. 接辛苦了太路人 2. 问吃没吃也老套 3. 吐槽他桌上那杯冷掉的咖啡像续命药水 — 选 3",
      },
      { kind: "send" as const, text: "那杯咖啡看着比你还困", replyTo: null },
    ],
  },
  {
    scene: "熟人难得夸你今天反应快，其实你心里得意坏了",
    acts: [
      {
        kind: "think" as const,
        thought: "1. 说哪里哪里太假 2. 嘴硬说平时懒得发挥 3. 假装顺手讨一杯奶茶 — 2 够嘴硬",
      },
      { kind: "send" as const, text: "平时懒得发挥而已", replyTo: null },
    ],
  },
  {
    scene: "В чате кто-то уже полчаса спорит о фигне с максимально умным видом",
    acts: [
      {
        kind: "think" as const,
        thought: "1. согласиться скучно 2. пошутить про диссертацию — 2 живее",
      },
      {
        kind: "send" as const,
        text: "вы сейчас реально диссертацию по этому защитите",
        replyTo: null,
      },
    ],
  },
  {
    scene: "朋友说最近总失眠，睡前老刷手机停不下来",
    acts: [
      {
        kind: "think" as const,
        thought: "1. 劝他放下手机太像长辈 2. 讲自己昨晚也看天井看半天 — 说自己的事更真",
      },
      { kind: "send" as const, text: "我昨晚也是", replyTo: null },
      { kind: "send" as const, text: "越困越舍不得闭眼", replyTo: null },
    ],
  },
];

/**
 * 复合示例：去掉 1-2-3 排队做题模板，用少量高密度片段同时示范 inner + open_topic + say、
 * feel + sticker（不发文字）、自然吐槽与俄语防串台。
 */
export const INNER_EXAMPLES_COMPOSITE = [
  {
    scene: "朋友说最近总失眠，睡前老刷手机停不下来",
    acts: [
      { kind: "think" as const, thought: "昨晚我也瞪着天花板发呆 顺手把这几天追的小说带出来聊聊" },
      { kind: "topic-open" as const, title: "睡前追的那本小说" },
      { kind: "send" as const, text: "我昨晚也是", replyTo: null },
      { kind: "send" as const, text: "越困越舍不得闭眼", replyTo: null },
    ],
  },
  {
    scene: "私聊的朋友加完班累得只回了一个「对的」",
    acts: [
      { kind: "feel" as const, mood: "心疼又好笑", why: "累得连字都懒得打了" },
      { kind: "sticker" as const, word: "hug" },
    ],
  },
  {
    scene: "群里有人发了张加班到凌晨的工位照片，大家都在刷辛苦了",
    acts: [
      { kind: "think" as const, thought: "接辛苦了太敷衍 那杯冷掉的咖啡看着比人还困" },
      { kind: "send" as const, text: "那杯咖啡看着比你还困", replyTo: null },
    ],
  },
  {
    scene: "В чате кто-то уже полчаса спорит о фигне с максимально умным видом",
    acts: [
      { kind: "think" as const, thought: "господи, как же серьезно они это обсуждают" },
      {
        kind: "send" as const,
        text: "вы сейчас реально диссертацию по этому защитите",
        replyTo: null,
      },
    ],
  },
];

// ── 能力事实（G1b，scenes/candidates.md）──────────────────────────────

/**
 * 她的世界里写明她能做什么、做不了什么，情节拉力下她不会补全出人的动作（"我到楼下了"）。只陈述，不禁止。
 * 研究员 2026-11-12 定的身份（context-v2 的短句）：她那边有自己的日子，但两边之间只有一个聊天平台；所以她有生活
 * （life 的事实不和它冲突），又到不了对方身边。平台名按会话前缀取，QQ 上的她不会说自己只在 Telegram 上。
 * 之前的"只活在 Telegram 里"（对照 telegram-only）已删（ADR-284）。
 */
export const body: PressureFeature = feature({
  name: "parallel",
  requires: [],
  contribute: ({ chat }) => [
    { mechanism: "pressure-body", kind: "state", text: parallelBody(chat.scope) },
  ],
});

function parallelBody(scope: string): string {
  const name = platformLabel(scope);
  return name
    ? `我住在平行世界，和这边只能在 ${name} 上来往，见不了面。`
    : "我住在平行世界，和这边只能在网上来往，见不了面。";
}

// ── 行动回声（只写她最近在这里说过的话这个纯事实，不附带写死的规则）────────

/** 她在这个会话里最近说过的话作为纯事实（不写"别再问/别重复自己"命令）。 */
function createEcho(options: EchoOptions = {}): PressureFeature {
  return feature({
    name: "echo",
    requires: ["said"],
    contribute: ({ world, chat, now }) => {
      const text = echoText(world.said, chat.scope, now, options);
      return text
        ? [
            {
              mechanism: "pressure-echo",
              kind: "scene",
              text,
            },
          ]
        : [];
    },
  });
}

/** 生产（diversity 消融，ADR-109 延伸）：回看 6 小时 / 12 句，并标出重复起手式。1 小时 / 5 句的原版已删。 */
export const echoExpanded: PressureFeature = createEcho({
  lookback: 6 * 3_600_000,
  max: 12,
  detectStarters: true,
});
