/**
 * ADR-220 + ADR-237: 私聊场景渲染器。
 *
 * 私聊是一对一对话——所有消息都对着你说。
 * 不出现社交全景（那是频道的事）。
 *
 * Sections（按顺序）：
 * 1. 时间 + 心情 + 对话对象 — LLM 感知"跟谁对话"和关系
 * 2. 防复读 — Alice 最近说了什么
 * 3. 消息流 — 最近对话
 * 4. 对话状态 — 已回复等待中？连发多条？
 * 5. 线程 — 活跃话题
 * 6. 行动反馈 — 上一轮行动的结果
 * 7. 内心低语 — 从 facet 获取的 whisper
 */

import type { UserPromptSnapshot } from "../types.js";
import {
  conversationStateBlock,
  feedbackBlocks,
  joinBlocks,
  listSectionBlock,
  openTopicsBlock,
  rawBlock,
  recapBlock,
  renderLocalClock,
  sectionBlock,
  whisperBlock,
} from "./shared.js";

export function renderPrivate(snapshot: UserPromptSnapshot): string {
  const isBot = snapshot.chatTargetType === "private_bot";
  const timeStr = renderLocalClock(snapshot.nowMs, snapshot.timezoneOffset);

  const introBlock = (() => {
    if (isBot) {
      const targetLabel = snapshot.target
        ? `Interacting with ${snapshot.target.displayName} (bot)`
        : "Interacting with a bot";
      return rawBlock(`${timeStr}. ${targetLabel}.`);
    }

    const targetLabel = snapshot.target
      ? `Talking to ${snapshot.target.displayName}`
      : "In a private chat";
    const relPart = snapshot.relationshipDesc ? ` (${snapshot.relationshipDesc})` : "";
    const moodPart = snapshot.contactMood ? ` They seem ${snapshot.contactMood}.` : "";
    const profileLine = (() => {
      if (!snapshot.contactProfile) return undefined;
      const parts: string[] = [];
      if (snapshot.contactProfile.portrait) parts.push(snapshot.contactProfile.portrait);
      if (snapshot.contactProfile.bio) {
        parts.push(`Bio: ${snapshot.contactProfile.bio.slice(0, 80)}`);
      }
      if (snapshot.contactProfile.traits.length > 0) {
        parts.push(`Traits: ${snapshot.contactProfile.traits.join(", ")}`);
      }
      if (snapshot.contactProfile.interests.length > 0) {
        parts.push(`Interests: ${snapshot.contactProfile.interests.join(", ")}`);
      }
      return parts.length > 0 ? `${parts.join(". ")}.` : undefined;
    })();

    return rawBlock(`${timeStr}. ${targetLabel}${relPart}.${moodPart}`, profileLine);
  })();

  return joinBlocks([
    introBlock,
    rawBlock(snapshot.emotionProjection),
    rawBlock(snapshot.emotionStyleHint),
    rawBlock(snapshot.roundHint, snapshot.episodeHint),
    conversationStateBlock(snapshot.presence),
    sectionBlock("Recent activity (private chat — all directed at you)", snapshot.timeline.lines),
    sectionBlock("Social cases", snapshot.socialCaseLines),
    openTopicsBlock(snapshot.threads),
    ...feedbackBlocks(snapshot.feedback),
    recapBlock(snapshot.conversationRecap),
    listSectionBlock("Timing", snapshot.timingSignals ?? []),
    listSectionBlock("What's happening", snapshot.situationSignals),
    listSectionBlock("Scheduled", snapshot.scheduledEvents),
    listSectionBlock("Caution", snapshot.riskFlags),
    rawBlock(snapshot.episodeCarryOver),
    rawBlock(
      snapshot.isDegraded ? "Running low — a reaction or a short line is enough." : undefined,
    ),
    rawBlock(snapshot.openTopic ? `You were talking about: ${snapshot.openTopic}.` : undefined),
    whisperBlock(snapshot.whisper, snapshot.presence),
  ]);
}
