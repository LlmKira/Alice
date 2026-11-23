/**
 * 反思（候选 reflect）的提示词与解析：她把刚才那段经历写进日记。写法照 2 月的日记：对谁、因为什么、她的感受，
 * 用她自己的口吻。带人格全文，因为日记要像她。条数、字数由写入方（diary.ts writeDiary）限定，这里不再截。
 */
import type { ReflectRequest } from "../mind/effects.js";
import type { Ponder } from "../mind/events.js";
import { moodWord } from "../mind/words.js";
import { readObject } from "./json.js";
import { nowLine, type SpeechPrompt } from "./prompt.js";
import { marked, parsePeople, peoplePrompt } from "./reflect-people.js";

const MAX_TOKENS = 400;

/**
 * 写下时标出托付的、私密的（PLAN 第 33 件，北极星不变量 1）：只有标了的留在这个聊天（和当时在场的人的私聊），
 * 其余的她在哪个聊天都想得起来，注明出处。标在同一次反思调用里，不另调模型。日记、心情、关于人的事、她自己的事
 * 都用这一句（reflect-people.ts 的字段也带 private）。
 */
const PRIVATE_RULE =
  "- private：这一条是别人托你保密的事，或明显私密的事（健康、感情、要给谁的惊喜），写 true；其余写 false。";

const rules = (
  examples: readonly string[],
) => `刚才那段对话之后，你在日记里写下此刻的想法。只输出一个 JSON 对象，不要别的文字：
{"entries": [{"about": "p编号"或null, "text": "…", "importance": 1到10, "private": true或false}], "mood": {"word": "心情", "why": "原因", "private": true或false}}
- 写你自己的感受，和你怎么看这件事：对谁、因为什么。用你平时的口吻，一两句，只写给自己看的心里话。
- 只写这段对话里真的发生过的事。
- about：这一条主要是关于某个人，就写他的 p 编号；关于整件事或你自己，写 null。
- importance：这件事对你有多重要，1 是很平常的小事（比如吃了顿早饭），10 是刻骨铭心的事（比如和最好的朋友闹翻、考上了想去的学校）。
- 日记里已经有的不用再写。没什么想写的就写空列表。最多 2 条。
- mood：写完之后你此刻的心情，用你自己的词；why 是一句原因（因为谁、因为什么）。说不上有什么心情就写 null。
${PRIVATE_RULE}
你以前的日记是这样写的（只是参考写法，不是这次要写的）：
${examples.map((t) => `- ${t}`).join("\n")}`;

export function renderReflectPrompt(persona: string, request: ReflectRequest): SpeechPrompt {
  const where = request.chatType === "group" ? "群聊" : "私聊";
  const lines = request.lines.map((l) => {
    const who = l.who === null ? "你" : `p${l.who + 1} ${request.people[l.who]?.name ?? "某人"}`;
    return `${who}: ${l.text}`;
  });
  const mood = request.mood;
  const people = peoplePrompt(request);
  const sections = [
    `这是刚才的${where}，按时间顺序：\n${lines.join("\n")}`,
    ...(mood ? [`你此刻的心情：${mood.word}${mood.why ? `（因为${mood.why}）` : ""}`] : []),
    ...(request.diary.length > 0
      ? [`你日记里还记得的：\n${request.diary.map((t) => `- ${t}`).join("\n")}`]
      : []),
    ...people.sections,
    nowLine({ timeline: [], at: request.at }),
  ];
  return {
    system: `${persona}\n\n${rules(request.examples)}${people.rules}`,
    user: sections.join("\n\n"),
    responseFormat: { type: "json_object" },
    maxTokens: MAX_TOKENS + people.tokens,
  };
}

class ReflectParseError extends Error {}

/** 读回 JSON。读不出对象就抛错（记为 ponder.failed）；单条不合格只丢那一条。 */
export function parseReflect(
  raw: string,
  request: ReflectRequest,
): Extract<Ponder, { kind: "reflect" }> {
  const value = readObject(raw);
  if (!value) throw new ReflectParseError(`not a JSON object: ${raw.slice(0, 120)}`);
  const person = (v: unknown): string | null => {
    const m = /^p?(\d+)$/i.exec(typeof v === "string" ? v.trim() : String(v ?? ""));
    return m ? (request.people[Number(m[1]) - 1]?.id ?? null) : null;
  };
  const entries = (Array.isArray(value.entries) ? value.entries : []).flatMap((r) => {
    const item = typeof r === "string" ? { text: r } : (r as Record<string, unknown>);
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    const n = Number(item?.importance);
    const importance = Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : null;
    return text ? [{ about: person(item.about), text, importance, ...marked(item.private) }] : [];
  });
  // 心情是她自己的词；效价由外壳另问（llm/tone.ts perceiveMood），这里只读词和原因。
  const m = value.mood as Record<string, unknown> | null | undefined;
  const why = typeof m?.why === "string" && m.why.trim() ? m.why.trim() : null;
  const word = typeof m?.word === "string" ? moodWord(m.word) : null;
  const mood = word ? { word, why, ...marked(m?.private) } : undefined;
  return {
    kind: "reflect",
    scope: request.scope,
    entries,
    ...(mood ? { mood } : {}),
    ...(request.learn ? { learned: parsePeople(value, request.learn, person, request) } : {}),
  };
}
