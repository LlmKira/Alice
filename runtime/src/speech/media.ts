/**
 * 非文字消息在她眼里是什么样：一句中文，写进时间线的方括号里（"[贴纸 😂]"、"[语音 8 秒]"、"[链接：标题——摘要]"）。
 * 只用平台随消息给的字段，不调模型（成熟做法与理由：docs/research/mature-designs-2026-11-11.md 之后的行动空间调研）。
 */

const LABELS = new Map(
  Object.entries({
    photo: "图片",
    sticker: "贴纸",
    voice: "语音",
    video: "视频",
    audio: "音频",
    document: "文件",
    webpage: "链接",
    poll: "投票",
    location: "位置",
    live_location: "实时位置",
    venue: "地点",
    contact: "名片",
    dice: "骰子",
    story: "动态",
  }),
);

/** 只知道类型时的写法（旧数据集只有类型）。 */
export function mediaLabel(contentType: string): string {
  return LABELS.get(contentType) ?? "消息";
}

/** 适配层从平台消息里取出的字段；没有的为 undefined。 */
export interface MediaFacts {
  type: string;
  emoji?: string;
  seconds?: number;
  round?: boolean;
  animation?: boolean;
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  performer?: string | null;
  fileName?: string | null;
  question?: string;
}

const clip = (s: string, n: number) => {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
};

/** 音乐写曲名和演唱者；两样都没有就按音频写时长。 */
function audioLine(m: MediaFacts, secs: string): string {
  const name = [m.title && `《${clip(m.title, 30)}》`, m.performer && clip(m.performer, 20)].filter(
    Boolean,
  );
  return name.length ? `音乐 ${name.join(" ")}` : `音频${secs}`;
}

/** 链接写标题（没有就写站名）和摘要。 */
function linkLine(m: MediaFacts): string {
  const head = m.title || m.siteName;
  if (!head) return "链接";
  return m.description
    ? `链接：${clip(head, 40)}——${clip(m.description, 60)}`
    : `链接：${clip(head, 40)}`;
}

export function describeMedia(m: MediaFacts): string {
  const seconds = m.seconds ?? 0;
  const secs = seconds > 0 ? ` ${Math.round(seconds)} 秒` : "";
  switch (m.type) {
    case "sticker":
      return m.emoji ? `贴纸 ${m.emoji}` : "贴纸";
    case "voice":
      return `语音${secs}`;
    case "video":
      if (m.animation) return "动图";
      return `${m.round ? "视频消息" : "视频"}${secs}`;
    case "audio":
      return audioLine(m, secs);
    case "document":
      return m.fileName ? `文件 ${clip(m.fileName, 40)}` : "文件";
    case "webpage":
      return linkLine(m);
    case "poll":
      return m.question ? `投票：${clip(m.question, 40)}` : "投票";
    case "dice":
      return m.emoji ? `骰子 ${m.emoji}` : "骰子";
    default:
      return mediaLabel(m.type);
  }
}
