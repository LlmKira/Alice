/**
 * ADR-220: 群组场景渲染器。
 *
 * 群组是社交对话——沉默是常态（90-9-1 法则）。
 * 不出现社交全景（那是频道的事）。
 *
 * Sections（按顺序）：
 * 1. 时间 + 心情 + 群组信息 — LLM 感知群组环境
 * 2. 防复读 — Alice 最近说了什么，避免复读机
 * 3. 消息流 — 最近对话
 * 4. 对话状态 — 已回复等待中？连发多条？
 * 5. 线程 — 活跃话题（LLM 需要 threadId 调用 topic_advance）
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

export function renderGroup(snapshot: UserPromptSnapshot): string {
  const timeStr = renderLocalClock(snapshot.nowMs, snapshot.timezoneOffset);
  const metaParts = ["group", snapshot.groupMeta?.membersInfo].filter(
    (part): part is string => part != null && part.length > 0,
  );
  const targetLabel = snapshot.target
    ? `Talking in ${snapshot.target.displayName}`
    : "In a group chat";

  const socialReceptionLine =
    snapshot.socialReception != null && snapshot.socialReception < -0.2
      ? snapshot.socialReception < -0.5
        ? "Someone was annoyed at your recent messages here. Stay back unless directly asked."
        : "Your recent messages here didn't get much response. Be selective about when you speak."
      : undefined;

  return joinBlocks([
    rawBlock(
      `${timeStr}. ${targetLabel} (${metaParts.join(", ")}).`,
      snapshot.groupMeta?.bio ? `About: ${snapshot.groupMeta.bio.slice(0, 100)}` : undefined,
      snapshot.groupMeta?.restrictions,
    ),
    rawBlock(snapshot.emotionProjection),
    rawBlock(snapshot.emotionStyleHint),
    rawBlock(snapshot.roundHint, snapshot.episodeHint),
    conversationStateBlock(snapshot.presence),
    sectionBlock("Recent activity", snapshot.timeline.lines),
    sectionBlock("Social cases", snapshot.socialCaseLines),
    rawBlock(
      snapshot.groupMeta?.directed ? "Someone directed a message at you." : undefined,
      snapshot.groupMeta?.topic ? `Current topic: ${snapshot.groupMeta.topic}` : undefined,
    ),
    openTopicsBlock(snapshot.threads),
    ...feedbackBlocks(snapshot.feedback),
    recapBlock(snapshot.conversationRecap),
    listSectionBlock(
      "Local slang",
      snapshot.jargon.map((jargon) => `"${jargon.term}" = ${jargon.meaning}`),
    ),
    listSectionBlock("Timing", snapshot.timingSignals ?? []),
    listSectionBlock("What's happening", snapshot.situationSignals),
    listSectionBlock("Scheduled", snapshot.scheduledEvents),
    listSectionBlock("Caution", snapshot.riskFlags),
    rawBlock(socialReceptionLine),
    rawBlock(snapshot.episodeCarryOver),
    rawBlock(
      snapshot.isDegraded ? "Running low — a reaction or a short line is enough." : undefined,
    ),
    rawBlock(snapshot.openTopic ? `You were talking about: ${snapshot.openTopic}.` : undefined),
    whisperBlock(snapshot.whisper, snapshot.presence),
  ]);
}
