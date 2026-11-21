/**
 * 每天醒来一次的生活内容生成（docs/research/her-life.md 第 2 片）：
 * 只读她的生活（LifeDayRequest，编译期不含任何聊天或联系人），写出今天几类日常的具体内容、
 * 0–2 件瞬间小事和跨天在做的事。进度与时间不由这里定，只由时间利用结构（life-body.ts）推进。
 */
import type { LifeDayRequest } from "../mind/effects.js";
import type { LifeDayPonder } from "../mind/events.js";
import { readObject } from "./json.js";
import type { SpeechPrompt } from "./prompt.js";

const MAX_ITEM_CHARS = 24;
const MAX_MOMENT_CHARS = 48;
const MAX_MOMENTS = 2;
const MAX_ONGOING = 3;
const MAX_CURIOSITY_TOPIC = 20;
const MAX_CURIOSITY_HOOK = 48;
const MAX_CURIOSITIES = 2;

const ACTIVITY_KINDS = ["wash", "meal", "snack", "shower", "game", "watch", "read"] as const;

export function renderLifeDayPrompt(persona: string, request: LifeDayRequest): SpeechPrompt {
  const prevActs = Object.entries(request.yesterday.activities)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const prevMoments = request.yesterday.moments.map((m) => `- ${m}`).join("\n");
  const prevOngoing = request.yesterday.ongoing.map((o) => `- ${o}`).join("\n");
  const intro = request.dream
    ? "你正在睡觉、迷迷糊糊做梦复盘昨天，顺便构思明天醒来后在自己世界里的日程与想找人聊聊的事。"
    : "现在是新的一天，安排你今天在自己世界里的日常小事（只属于你一个人的生活，没有别人）。";

  const system = `${persona}

${intro}
只输出一个 JSON 对象，不要其他文字：
{
  "activities": {
    "meal": "今天吃什么（≤16字，如 番茄炒蛋配米饭）",
    "snack": "夜宵或零食（≤16字）",
    "game": "今天玩什么游戏（≤16字）",
    "watch": "今天看什么剧或番（≤16字）",
    "read": "今天看什么书（≤16字）"
  },
  "moments": [
    { "hour": 14, "text": "今天顺手发生的一件小事（≤30字，如 煮汤稍微煮溢出来了）" }
  ],
  "ongoing": ["这几天一直断断续续在做的事（≤24字，1到2件）"],
  "curiosities": [
    { "topic": "核心词（≤12字，如 芙莉莲）", "hook": "自己琢磨或想随口跟朋友提一句的事（≤36字）" }
  ]
}

要求：
- 贴合你的性格，保持连贯但每天有点小变化，不要每次都一模一样；
- moments 给 0 到 2 条，hour 取 9 到 23 之间的整数；
- curiosities 给 0 到 2 条，是你自己真正好奇或想吐槽/分享的念头；
- 全都发生在你自己的平行世界家里或日常里，不出现真实网友或 Telegram 上的事。`;

  const user = [
    `日期：${request.date}`,
    request.dream?.moodHint ? `睡前自己的整体心情底色：${request.dream.moodHint}` : "",
    prevActs ? `前一天在做：\n${prevActs}` : "",
    prevMoments ? `前一天的小事：\n${prevMoments}` : "",
    prevOngoing ? `这几天还在做的：\n${prevOngoing}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user, responseFormat: { type: "json_object" }, maxTokens: 500 };
}

function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  return s.length > 0 ? s.slice(0, max) : null;
}

export function parseLifeDay(raw: string, request: LifeDayRequest): LifeDayPonder {
  const obj = readObject(raw);
  if (!obj) {
    return {
      kind: "life",
      date: request.date,
      activities: {},
      moments: [],
      ongoing: [],
      curiosities: [],
    };
  }
  const activities: Partial<Record<string, string>> = {};
  const rawActs = obj.activities;
  if (typeof rawActs === "object" && rawActs !== null) {
    for (const k of ACTIVITY_KINDS) {
      const val = cleanText((rawActs as Record<string, unknown>)[k], MAX_ITEM_CHARS);
      if (val) activities[k] = val;
    }
  }
  const moments: Array<{ hour: number; text: string }> = [];
  if (Array.isArray(obj.moments)) {
    for (const item of obj.moments) {
      if (moments.length >= MAX_MOMENTS) break;
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const text = cleanText(rec.text, MAX_MOMENT_CHARS);
      const h =
        typeof rec.hour === "number" && Number.isFinite(rec.hour) ? Math.round(rec.hour) : 15;
      if (text) moments.push({ hour: Math.min(23, Math.max(8, h)), text });
    }
  }
  const ongoing: string[] = [];
  if (Array.isArray(obj.ongoing)) {
    for (const item of obj.ongoing) {
      if (ongoing.length >= MAX_ONGOING) break;
      const s = cleanText(item, MAX_ITEM_CHARS);
      if (s) ongoing.push(s);
    }
  }
  const curiosities: Array<{ topic: string; hook: string }> = [];
  if (Array.isArray(obj.curiosities)) {
    for (const item of obj.curiosities) {
      if (curiosities.length >= MAX_CURIOSITIES) break;
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const topic = cleanText(rec.topic, MAX_CURIOSITY_TOPIC);
      const hook = cleanText(rec.hook, MAX_CURIOSITY_HOOK);
      if (topic && hook) curiosities.push({ topic, hook });
    }
  }
  return {
    kind: "life",
    date: request.date,
    activities,
    moments,
    ongoing,
    ...(curiosities.length > 0 ? { curiosities } : {}),
  };
}
