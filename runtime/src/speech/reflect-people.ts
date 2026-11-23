/**
 * 反思时顺手记下关于人的事（people，mechanisms/pressure/people.ts）：在同一次反思调用里多要对方说出来的具体的事
 * （R05）。不加调用次数。群印象（R08）2026-11-13 删了。
 * 只记具体的事，不写性格画像、不打信任分：画像总结会加重谄媚（OP-Bench 转述，PLAN"连续性"）。
 * 更新照 Mem0 的做法放进同一次调用：她看得到自己已经记得的事，对不上了就写出被改掉的那条旧的原文
 * （2 月 update_fact 也要逐字给出旧内容）。
 * 也记她自己说出口的关于她自己的事（PeopleAsk.self），同一次调用。
 */
import type { PeopleAsk, PeopleLearned, ReflectRequest } from "../mind/effects.js";

/** 顺手记关于人的事时多给的输出长度。 */
const PEOPLE_TOKENS = 300;
/** 也记她自己的事时再多给的。 */
const SELF_TOKENS = 150;

/** 反思提示词里关于人的那几部分；没问（request.learn 没有）时全空。 */
export function peoplePrompt(request: ReflectRequest): {
  rules: string;
  sections: string[];
  tokens: number;
} {
  const ask = request.learn;
  if (!ask) return { rules: "", sections: [], tokens: 0 };
  return {
    rules: `\n${peopleRules(ask)}`,
    sections: peopleSection(request, ask),
    tokens: PEOPLE_TOKENS + (ask.self ? SELF_TOKENS : 0),
  };
}

/** 她自己说出口的事（eval-artifacts/memory-b/）。 */
const SELF_RULES = [
  '- self：你自己在这段对话里当真说出口的、关于你自己的事：稳定的喜好、平时的习惯、你这边真实的近况（比如"不吃香菜""最近在追一部番""煮面把汤溢出来了"）。一件一条，写成平实的短话，时间交给记录（写"煮面把汤溢出来了"，不写"刚才"）。当场的玩笑和逗人的夸张话属于那一刻，留在对话里就好；像犯困、犯懒这类一时的状态也留在对话里，不写进 self；心情写在 mood 里；和对方有关的记在 facts 里。没有就写空列表。',
  "- self 记你的喜好、习惯和你这边的近况；你是谁由你自己的设定来定。",
  "- 每条 self 都来自你自己说的一句话：said 照抄那句话里讲这件事的几个字。",
  "- 下面列着你已经说过的关于你自己的事，说过的不用再记；和说过的对不上了，replaces 写那条旧的原文。",
];

/**
 * 出处：facts、self 的每一条都要照抄一句原话里的几个字（said），校验时它必须出现在那个人自己在这段对话里说的话里。
 * 规则早就写了"不写性格"，模型照样写画像和"该怎么对他"（线上"Rumun：满嘴跑火车……如果没人损他会觉得没意思"、
 * 她自己"在对线时反应极快，能精准地针对对方的短板进行辛辣反击"，eval-artifacts/live-review/2026-11-13.md）。
 * 这类话不是谁的原话，就找不到出处。
 */
const SAID_RULE =
  '- 每条 facts 都来自他自己说的一句话：said 照抄那句话里讲这件事的几个字，text 用一句平实的短话写那句话说的事（比如 said "我家猫叫年糕"，text "养了一只叫年糕的猫"）。';

const bare = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/** said 照抄的几个字，在这个人（who 是 people 的下标，她自己是 null）这段对话里的原话里找得到。 */
function quoted(lines: ReflectRequest["lines"], who: number | null, said: string | null): boolean {
  const words = said ? bare(said) : "";
  if ([...words].length < 2) return false;
  return lines.some((l) => l.who === who && bare(l.text).includes(words));
}

function peopleRules(ask: PeopleAsk): string {
  const fields = [
    ask.facts
      ? `"facts": [{"about": "p编号", "said": "他那句原话里的几个字", "text": "…", "when": "原话里的时间"或null, "replaces": "要改掉的那条旧的原文"或null, "private": true或false}]`
      : null,
    ask.self
      ? `"self": [{"said": "你那句原话里的几个字", "text": "…", "replaces": "要改掉的那条旧的原文"或null, "private": true或false}]`
      : null,
  ].filter((f) => f !== null);
  const lines = [
    `同一个 JSON 对象里还要有：${fields.join("，")}`,
    ...(ask.facts
      ? [
          '- facts：对方自己说出来的、关于他的具体的事，比如做什么工作、养了什么、在准备什么、什么时候要去哪。一件事一条，写成一句平实的短话（比如"养了一只叫年糕的猫"）。不写他的性格，不写你对他的看法，不猜，也不记你自己的事。没有就写空列表。',
          SAID_RULE,
          '- 有时间的事，when 照抄他原话里说时间的那几个字（"明天""下周四""11月20日"），不要自己换算成日期；text 里不要写"明天"这种过几天就不对的说法。',
          "- 下面列着你已经记得的事，记得的不用再记；和记得的对不上了（换了工作、搬了家），replaces 写那条旧的原文。",
        ]
      : []),
    ...(ask.self ? SELF_RULES : []),
  ];
  return lines.join("\n");
}

/** 用户提示里多的两段：她已经记得的关于这些人的事，她之前对这个群的印象。 */
function peopleSection(request: ReflectRequest, ask: PeopleAsk): string[] {
  const known = ask.known
    .filter((k) => k.facts.length > 0)
    .map((k) => {
      const name = request.people[k.who]?.name ?? "某人";
      return `- p${k.who + 1} ${name}：${k.facts.join("；")}`;
    });
  const self = ask.self?.known ?? [];
  return [
    ...(ask.facts && known.length > 0 ? [`你已经记得的关于他们的事：\n${known.join("\n")}`] : []),
    ...(self.length > 0
      ? [`你已经说过的关于你自己的事：\n${self.map((t) => `- ${t}`).join("\n")}`]
      : []),
  ];
}

/** 模型写的 private（reflect.ts PRIVATE_RULE）：只有 true 算标了。 */
export const marked = (v: unknown): { private?: true } => (v === true ? { private: true } : {});

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/**
 * 读回问了的那几样；不合格的单条丢掉，没问的不读。about 认不出人的丢掉（不猜是谁）。facts、self 找不到出处的丢掉
 * （quoted：said 要出现在那个人自己这段对话里的原话里）。
 */
export function parsePeople(
  value: Record<string, unknown>,
  ask: PeopleAsk,
  person: (v: unknown) => string | null,
  request: Pick<ReflectRequest, "lines" | "people">,
): PeopleLearned {
  const list = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  const facts = ask.facts
    ? list(value.facts).flatMap((r) => {
        const about = person(r?.about);
        const text = str(r?.text, 200);
        const said = str(r?.said, 200);
        const who = request.people.findIndex((p) => p.id === about);
        return about && text && quoted(request.lines, who, said)
          ? [
              {
                about,
                said,
                text,
                when: str(r.when, 40),
                replaces: str(r.replaces, 200),
                ...marked(r.private),
              },
            ]
          : [];
      })
    : undefined;
  const self = ask.self
    ? list(value.self).flatMap((r) => {
        const text = str(r?.text, 200);
        const said = str(r?.said, 200);
        return text && quoted(request.lines, null, said)
          ? [{ said, text, replaces: str(r.replaces, 200), ...marked(r.private) }]
          : [];
      })
    : undefined;
  return {
    ...(facts ? { facts } : {}),
    ...(self ? { self } : {}),
  };
}
