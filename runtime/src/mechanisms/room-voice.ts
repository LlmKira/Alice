import type { AliceEvent } from "../mind/events.js";
import { type Contribution, defineMechanism, type Mechanism } from "../mind/mechanism.js";
import { fnv1a as hash } from "./hash.js";

/**
 * 这个群的人平时怎么打字（生产，2026-11-13；PLAN 第 42、49 件，docs/adr/282-speech-style-and-room-voice.md）。
 *
 * 为什么：线上判别员 41 段认出她 40 段，靠的是说话的样子（比群友长 2–4 倍、感叹号、句末表情、一条塞几句）；她看不到
 * 这个群的人平时怎么打字，群友的话只出现在聊天记录里。按群 fold 群友的消息，到了冷启动门槛才写：说得多的那些人的长短、
 * 一条几句、一轮几条、引用回复挂在哪、开口点名、感叹号、句尾表情、只发贴纸，她自己最近在这里带感叹号的条数，再加三段
 * 清洗过的群友之间的接话（引用回复的一对，和"有人回复了他、他直接接着说"的一对按这个群的比例混着放），写成群友之间
 * 的话，不写成她的台词。只回到同一个群的提示词里；不取她此刻记录里看得到的消息。文字是 Gemini 改稿 4 的写法。
 *
 * 依据：real-v1 开发集两遍，挑毛病 24 : 8，正面问法 37 : 19，风格五项里四项落进同群活跃真人的 p10–p90。
 * 下一步（研究员 2026-11-13"不给数字，给最好的黄金示例"）：这里的比例换成挑出来的群友真话，PLAN 第 54 件。
 */

interface RoomMessage {
  id: string;
  at: number;
  who: string;
  text: string | null;
  sticker: boolean;
  replyTo: string | null;
  /** 回复她、点她名的那些（不进原话示范）。 */
  directed: boolean;
}
type Said = RoomMessage & { text: string };

export interface RoomState {
  /** 每个群最近 KEPT 条群友的消息（机器人账号、命令、频道帖不算）。 */
  rooms: Readonly<Record<string, readonly RoomMessage[]>>;
  /** 每个群里见过的发言人名字（和名字的第一个词），算开口点名用。 */
  names: Readonly<Record<string, readonly string[]>>;
  /** 平台标过是机器人的发送者（旧数据只在后来的消息上标，所以按人记，标到时把他之前的消息也去掉）。 */
  bots?: readonly string[];
  /** 她自己最近在每个会话里发出的文字（最近 MINE_KEPT 条）。 */
  mine?: Readonly<Record<string, readonly string[]>>;
}

/**
 * 候选的写法（out-charm.md 改法 2，eval-artifacts/charm/report.md）：不给数字、挑掉水词和空回声。
 * 默认两项都关，和生产逐字相同。
 * - noNumbers：不写字数、比例和统计，只在群里几乎不用感叹号而她最近 10 句里超过一半带感叹号时提醒一句；
 * - filterWater：群友的原话示范跳过纯叹词/水词（草、6、Да.）和空回声（`А чо я? / а я чо?`）。
 */
interface RoomVoiceOptions {
  noNumbers?: boolean;
  filterWater?: boolean;
  /** 按调用次数与 15 分钟窗口轮换群友接话示范（替代按整天锁死）。 */
  perCall?: boolean;
}

/** 每个群留多少条。手设。 */
const KEPT = 500;
/** 冷启动：群友消息少于这么多条，或者说得多的人少于 MIN_ACTIVE 个，就什么都不写。手设。 */
const MIN_MESSAGES = 50;
const MIN_ACTIVE = 3;
/** 说得多的人：按条数排在前一半，并且至少这么多条。 */
const MIN_ACTIVE_COUNT = 5;
/** 放几段群友之间的接话。 */
const EXCHANGES = 3;
const NAMES_KEPT = 300;
/** 按情境的那几条事实，各自的样本不到这么多就不写。 */
const SITUATION_MIN = 10;
/** 有人回复了某个群友后，看他在这么久、这么多条以内的下一条文字。 */
const ANSWER_MS = 5 * 60_000;
const ANSWER_SPAN = 30;
/** 她自己的话留几条、至少几条才写。 */
const MINE_KEPT = 50;
const MINE_MIN = 10;
/** 同一个人连着发、中间没人插话、相隔这么久以内算一轮。 */
const TURN_MS = 2 * 60_000;

const CJK = /[一-鿿]/g;
const HAS_CJK = /[一-鿿]/;
const EMOJI_END = /\p{Extended_Pictographic}️?\s*$/u;
const URL = /https?:\/\/|t\.me\/|www\./i;
const HER = /alice|алис|элис|爱丽丝|愛麗絲|アリス|艾丽丝/i;
/** 粗口（俄、中、英的常见词根）：带这些的原话不进示范，统计照算。 */
const PROFANE =
  /ху[йеёяи]|пизд|[её]б[аеуы]|ебл|бля|сук[аи]|муда|пид[оа]?р|гандон|залуп|шлюх|дроч|[操肏屌婊]|傻逼|煞笔|妈的|他妈|你妈|鸡巴|fuck|shit|bitch|cunt|dick|asshole/i;
const SENTENCE_END = /[。！？!?…]+|\n+|(?<=\.)\s+/;
/** 纯叹词/水词（норм、草、6）：金句过滤时不算"有实质内容"。 */
const BARE =
  /^(?:[аия草6甜嗯啊哦哈好对是牛在噗啥]|ну|да|нет|чо|что|ты|он|она|это|ясно|ок|ok|ладно|ага|угу|хм|ха|лол|пфф|是的|确实|真的|牛的|可以)$/u;
const DAY_MS = 24 * 60 * 60_000;
const CN_OFFSET_MS = 8 * 60 * 60_000;
const ROTATION_WINDOW_MS = 15 * 60_000;

/** 长短：中文群按字（夹着的外文词一个算一个），别的群按词。 */
function units(text: string, chinese: boolean): number {
  if (!chinese) return text.split(/\s+/).filter(Boolean).length;
  const cjk = text.match(CJK)?.length ?? 0;
  return (
    cjk +
    text
      .replace(CJK, " ")
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  );
}

function sentencesOf(text: string): number {
  return Math.max(1, text.split(SENTENCE_END).filter((p) => /[\p{L}\p{N}]/u.test(p)).length);
}

/**
 * 金句过滤（out-charm.md 改法 2，候选 roomVoiceGolden）：纯叹词、水词、空话不算"有实质内容"——
 * 中文不到 4 个字、别的语言不到 3 个词，或整句就是一个叹词（草、6、Да.、Ясно...）。
 */
function watery(text: string, chinese: boolean): boolean {
  const t = text
    .trim()
    .replace(/[.!?！？…~～\s]+/gu, " ")
    .trim();
  if (!t) return true;
  if (units(t, chinese) < (chinese ? 4 : 3)) return true;
  return BARE.test(t.toLowerCase());
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

/** 一对空回声（`А чо я? / а я чо?`）：两边是同样几个词，或者短的那边不到三个词且被另一边包住。 */
function echoPair(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return true;
  if (x.size === y.size && [...x].every((w) => y.has(w))) return true;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return small.size <= 2 && [...small].every((w) => big.has(w));
}

const initial: RoomState = { rooms: {}, names: {} };

export function reduceRoom(s: RoomState, e: AliceEvent): RoomState {
  if (e.type === "message.sent") {
    if (e.kind !== "text") return s;
    const text = e.text.trim();
    if (!text) return s;
    const mine = [...(s.mine?.[e.scope] ?? []), text].slice(-MINE_KEPT);
    return { ...s, mine: { ...s.mine, [e.scope]: mine } };
  }
  if (e.type !== "message.received" || e.chatType !== "group") return s;
  if (e.isBot) {
    if (s.bots?.includes(e.senderId)) return s;
    const rooms = Object.fromEntries(
      Object.entries(s.rooms).map(([k, v]) => [k, v.filter((m) => m.who !== e.senderId)]),
    );
    return { ...s, rooms, bots: [...(s.bots ?? []), e.senderId] };
  }
  // 频道以群的身份发的帖子（发送者是负的会话编号）、机器人、命令都不是群友在打字。
  if (e.senderId.startsWith("-") || s.bots?.includes(e.senderId)) return s;
  const text = e.text?.trim() || null;
  if (text?.startsWith("/")) return s;
  const msg: RoomMessage = {
    id: e.messageId,
    at: e.at,
    who: e.senderId,
    text,
    sticker: e.contentType === "sticker",
    replyTo: e.replyToMessageId,
    directed: e.directed,
  };
  const room = [...(s.rooms[e.scope] ?? []), msg].slice(-KEPT);
  const name = e.senderName.trim();
  const words = name ? [name, name.split(/\s+/)[0] ?? name].filter((n) => n.length >= 2) : [];
  const known = s.names[e.scope] ?? [];
  const names = words.some((n) => !known.includes(n))
    ? [...known, ...words.filter((n) => !known.includes(n))].slice(-NAMES_KEPT)
    : known;
  return {
    ...s,
    rooms: { ...s.rooms, [e.scope]: room },
    names: names === known ? s.names : { ...s.names, [e.scope]: names },
  };
}

const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const share = (xs: readonly boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const pct = (x: number) => (x < 0.03 ? "几乎没有" : `约 ${Math.round(x * 20) * 5}%`);

/** 这个群此刻的打字样子；没到冷启动门槛时为 null。 */
function roomFacts(room: readonly RoomMessage[], names: readonly string[]) {
  if (room.length < MIN_MESSAGES) return null;
  const counts = new Map<string, number>();
  for (const m of room) counts.set(m.who, (counts.get(m.who) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const active = new Set(
    ranked
      .slice(0, Math.ceil(ranked.length / 2))
      .filter(([, n]) => n >= MIN_ACTIVE_COUNT)
      .map(([who]) => who),
  );
  if (active.size < MIN_ACTIVE) return null;
  const theirs = room.filter((m) => active.has(m.who));
  const texts = theirs.filter((m): m is Said => m.text !== null);
  if (texts.length < MIN_MESSAGES / 2) return null;
  const chinese = share(texts.map((m) => HAS_CJK.test(m.text))) >= 0.5;
  const lengths = texts.map((m) => units(m.text, chinese)).sort((a, b) => a - b);
  const nameFirst = (t: string) =>
    t.startsWith("@") || names.some((n) => t.toLowerCase().startsWith(n.toLowerCase()));
  return {
    active: active.size,
    chinese,
    unit: chinese ? "字" : "个词",
    p25: quantile(lengths, 0.25),
    median: quantile(lengths, 0.5),
    p75: quantile(lengths, 0.75),
    nameFirst: share(texts.map((m) => nameFirst(m.text))),
    exclaim: share(texts.map((m) => /[!！]/.test(m.text))),
    emojiEnd: share(texts.map((m) => EMOJI_END.test(m.text))),
    sticker: share(theirs.map((m) => m.sticker)),
    activeIds: active,
  };
}
type Facts = NonNullable<ReturnType<typeof roomFacts>>;

/** quoteSituations 的结果：两个比例（样本不够时为 null）和"有人回复他、他直接接话"的那些对。 */
interface QuoteSituations {
  latest: number | null;
  direct: number | null;
  directPairs: Array<{ reply: RoomMessage; answer: RoomMessage }>;
}

/**
 * 引用回复按情境：latest 是群友的引用里挂在紧挨着的上一条上的比例；direct 是有人回复了某个群友、这个群友 5 分钟内接着
 * 说话时，没有把那条回复引用回去的比例（他引用别的话也算）。real-v1 上只给一个笼统的引用比例时，她在有人刚回复她时
 * 引用回去 65%，真人 27%。
 */
function quoteSituations(room: readonly RoomMessage[]): QuoteSituations {
  const index = new Map(room.map((m, i) => [m.id, i]));
  let quotes = 0;
  let latest = 0;
  const answers: Array<{ reply: RoomMessage; answer: RoomMessage }> = [];
  room.forEach((m, i) => {
    const t = m.replyTo ? index.get(m.replyTo) : undefined;
    if (t === undefined) return;
    quotes++;
    if (t === i - 1) latest++;
    const target = room[t];
    if (!target || target.who === m.who) return;
    for (const n of room.slice(i + 1, i + 1 + ANSWER_SPAN)) {
      if (n.at - m.at > ANSWER_MS) break;
      if (n.who === target.who && n.text !== null) {
        answers.push({ reply: m, answer: n });
        break;
      }
    }
  });
  const notBack = answers.filter((a) => a.answer.replyTo !== a.reply.id);
  return {
    latest: quotes >= SITUATION_MIN ? latest / quotes : null,
    direct: answers.length >= SITUATION_MIN ? notBack.length / answers.length : null,
    directPairs: answers.filter((a) => a.answer.replyTo === null),
  };
}

/** 一条几句、一轮几条（说得多的那些人）。real-v1 上她每条 1.2–1.6 句，真人 1.15 句；她一轮约 1.0 条，真人 1.1–1.9 条。 */
function typingTurns(room: readonly RoomMessage[], active: ReadonlySet<string>) {
  const texts = room.filter((m): m is Said => m.text !== null && active.has(m.who));
  const runs: number[] = [];
  room.forEach((m, i) => {
    const prev = room[i - 1];
    if (prev && prev.who === m.who && m.at - prev.at <= TURN_MS) {
      if (active.has(m.who)) runs[runs.length - 1] = (runs.at(-1) ?? 0) + 1;
    } else if (active.has(m.who)) runs.push(1);
  });
  return texts.length >= MIN_MESSAGES / 2 && runs.length >= SITUATION_MIN
    ? {
        multi: share(texts.map((m) => sentencesOf(m.text) >= 2)),
        perTurn: runs.reduce((s, n) => s + n, 0) / runs.length,
      }
    : null;
}

/** 能进示范的一句群友原话：说得多的人说的、长短在这个群的中间一半里、不带链接、不提她、不冲着她、不带粗口。 */
function clean(m: RoomMessage, facts: Facts, filterWater = false): m is Said {
  if (m.text === null || m.directed) return false;
  if (filterWater && watery(m.text, facts.chinese)) return false;
  const n = units(m.text, facts.chinese);
  return (
    n >= facts.p25 &&
    n <= facts.p75 &&
    m.text.length <= 160 &&
    !URL.test(m.text) &&
    !HER.test(m.text) &&
    !PROFANE.test(m.text)
  );
}

interface Shown {
  a: Said;
  b: Said;
  kind: "quote" | "direct";
}

/** 三段接话：引用回复的一对，和"有人回复了他、他直接接着说"的一对按这个群的比例混着放；按群和日子轮换。 */
function exchanges(
  scope: string,
  seed: number | string,
  room: readonly RoomMessage[],
  facts: Facts,
  visible: ReadonlySet<string>,
  situations: QuoteSituations,
  filterWater = false,
): Shown[] {
  const ok = (m: RoomMessage | undefined): m is Said =>
    !!m && !visible.has(m.id) && facts.activeIds.has(m.who) && clean(m, facts, filterWater);
  const pairOk = (a: Said, b: Said) => !filterWater || !echoPair(a.text, b.text);
  const byId = new Map(room.map((m) => [m.id, m]));
  const quotePairs = room.flatMap((b): Shown[] => {
    const quoted = b.replyTo ? byId.get(b.replyTo) : undefined;
    return quoted && quoted.who !== b.who && ok(quoted) && ok(b) && pairOk(quoted, b)
      ? [{ a: quoted, b, kind: "quote" }]
      : [];
  });
  const directPairs = situations.directPairs.flatMap(({ reply, answer }): Shown[] =>
    ok(reply) && ok(answer) && pairOk(reply, answer)
      ? [{ a: reply, b: answer, kind: "direct" }]
      : [],
  );
  const rank = (xs: Shown[]) =>
    xs
      .map((p) => ({ p, h: hash(`${scope}|${seed}|${p.a.id}|${p.b.id}`) }))
      .sort((x, y) => x.h - y.h)
      .map((x) => x.p);
  const wantDirect = situations.direct === null ? 0 : Math.round(EXCHANGES * situations.direct);
  const chosen: Shown[] = [];
  const used = new Set<string>();
  const take = (xs: Shown[], n: number) => {
    for (const p of xs) {
      if (chosen.length >= EXCHANGES || n <= 0) break;
      if (used.has(p.a.id) || used.has(p.b.id)) continue;
      chosen.push(p);
      used.add(p.a.id);
      used.add(p.b.id);
      n--;
    }
  };
  const d = rank(directPairs);
  const q = rank(quotePairs);
  take(d, wantDirect);
  take(q, EXCHANGES);
  take(d, EXCHANGES);
  return chosen.sort((x, y) => x.b.at - y.b.at);
}

/** 打字尺度那几行（Gemini 改稿 4 的写法和顺序）。golden 只给一句客观的感叹号提醒（见 RoomVoiceOptions）。 */
function factLines(
  facts: Facts,
  room: readonly RoomMessage[],
  mine: readonly string[],
  situations: QuoteSituations,
  noNumbers = false,
): string[] {
  if (noNumbers) {
    const recent = mine.slice(-10);
    const excited = recent.length === 10 && recent.filter((t) => /[!！]/.test(t)).length > 5;
    return facts.exclaim < 0.15 && excited
      ? ["这个群平时几乎不用感叹号，你最近在这里带感叹号的句子偏多。"]
      : [];
  }
  const u = facts.unit;
  const span = facts.p25 === facts.p75 ? `${facts.p25}` : `${facts.p25}–${facts.p75}`;
  const turns = typingTurns(room, facts.activeIds);
  const own =
    mine.length >= MINE_MIN
      ? `（你最近在这里发的 ${mine.length} 句里有 ${mine.filter((t) => /[!！]/.test(t)).length} 句带感叹号）`
      : "";
  return [
    `这个群的人平时怎么打字（最近说得多的 ${facts.active} 个人；只反映这个群的打字习惯与群友之间怎么接话，不代表你的性格）`,
    `一条文字通常 ${span} ${u}，中位 ${facts.median} ${u}${
      turns
        ? `；多半只有一句话，两句以上的${pct(turns.multi)}；想多说时常分成几条接着发（平均一轮 ${turns.perTurn.toFixed(1)} 条）`
        : ""
    }`,
    ...(situations.latest === null
      ? []
      : [
          `群友的引用回复里，挂在紧挨着的上一条上的${pct(situations.latest)}，其余挂在隔了几条的话上`,
        ]),
    [
      ...(situations.direct === null
        ? []
        : [
            `有人回复了某个群友，这个群友接着说话时，${pct(situations.direct)} 没有把那条回复再引用回去`,
          ]),
      `开口先叫人名的${pct(facts.nameFirst)}`,
    ].join("；"),
    `带感叹号的${pct(facts.exclaim)}${own}；以表情结尾的${pct(facts.emojiEnd)}；只发一张贴纸的${pct(facts.sticker)}`,
  ];
}

/**
 * 候选（out-charm.md 改法 2）：roomVoiceGolden 是"不给数字、挑水词"的那一版；roomVoice 不带选项，
 * 与生产逐字相同。
 */
function createRoomVoice(options: RoomVoiceOptions = {}): Mechanism {
  return defineMechanism<RoomState>({
    name: "room-voice",
    initial,
    reduce: reduceRoom,
    contribute: (chat, now, state): Contribution[] => {
      if (chat.chatType !== "group") return [];
      const room = state.rooms[chat.scope] ?? [];
      const facts = roomFacts(room, state.names[chat.scope] ?? []);
      if (!facts) return [];
      const seed = options.perCall
        ? `${chat.calls}|${Math.floor(now / ROTATION_WINDOW_MS)}`
        : Math.floor((now + CN_OFFSET_MS) / DAY_MS);
      const situations = quoteSituations(room);
      const lines = factLines(
        facts,
        room,
        state.mine?.[chat.scope] ?? [],
        situations,
        options.noNumbers,
      );
      const visible = new Set(chat.timeline.map((e) => e.messageId));
      const shown = exchanges(
        chat.scope,
        seed,
        room,
        facts,
        visible,
        situations,
        options.filterWater,
      );
      const flat = (t: string) => t.replace(/\s*\n\s*/g, " ");
      if (shown.length > 0) {
        lines.push("群友之间的几段接话（看他们怎么断句和接话，不照抄具体词句）：");
        shown.forEach(({ a, b, kind }, i) => {
          if (i > 0) lines.push("  ---");
          if (kind === "quote") {
            lines.push(`  <成员A> ${flat(a.text)}`);
            lines.push(`  <成员B> （回复上一条）${flat(b.text)}`);
          } else {
            lines.push(`  <成员A> （回复成员B）${flat(a.text)}`);
            lines.push(`  <成员B> ${flat(b.text)}`);
          }
        });
      }
      return [{ mechanism: "room-voice", kind: "reference", text: lines.join("\n") }];
    },
  });
}

/** 生产：与 2026-11-13 上线的那一份逐字相同（默认不开任何候选写法）。 */
export const roomVoice = createRoomVoice();

/** 候选：不给数字、挑掉群友的水词和空回声（out-charm.md 改法 2）。 */
export const roomVoiceGolden = createRoomVoice({ noNumbers: true, filterWater: true });

/** 候选（diversity 消融）：按调用与 15 分钟窗轮换群友接话。 */
export const roomVoiceRotated = createRoomVoice({ perCall: true });
