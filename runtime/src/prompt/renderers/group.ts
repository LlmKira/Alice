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
import { localNow } from "../../telegram/apps/shared.js";

export function renderGroup(snapshot: UserPromptSnapshot): string {
  const lines: string[] = [];

  // ── Section 1: 时间 + 心情 + 群组信息 ──
  // LLM 需要知道群组环境来调整参与度
  // ADR-34: 使用配置的时区，而非系统时区
  const now = localNow(snapshot.timezoneOffset);
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  const timeStr = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;

  const metaParts: string[] = [];
  metaParts.push("group");
  if (snapshot.groupMeta?.membersInfo) {
    metaParts.push(snapshot.groupMeta.membersInfo);
  }
  const targetLabel = snapshot.target
    ? `Talking in ${snapshot.target.displayName}`
    : "In a group chat";
  lines.push(
    `${timeStr}. ${targetLabel} (${metaParts.join(", ")}). Current mood: ${snapshot.moodLabel}.`,
  );

  // 群组简介
  if (snapshot.groupMeta?.bio) {
    lines.push(`About: ${snapshot.groupMeta.bio.slice(0, 100)}`);
  }

  // 群聊限制
  if (snapshot.groupMeta?.restrictions) {
    lines.push(snapshot.groupMeta.restrictions);
  }

  // 轮次感知
  if (snapshot.roundHint) {
    lines.push("");
    lines.push(snapshot.roundHint);
  }
  // ADR-232: TC episode 提示（watching 续轮后，告知结果已可见）
  if (snapshot.episodeHint) {
    lines.push(snapshot.episodeHint);
  }

  // ── Section 2: 防复读 ──
  // LLM 需要知道自己最近说了什么来避免重复
  if (
    snapshot.presence &&
    snapshot.presence.trailingYours >= 1 &&
    snapshot.presence.lastOutgoingPreview
  ) {
    lines.push("");
    lines.push("## Conversation State");
    lines.push(
      `Replied ~${snapshot.presence.lastOutgoingAgo}: "${snapshot.presence.lastOutgoingPreview}"`,
    );
    if (snapshot.presence.trailingYours >= 3) {
      lines.push("Still no response. Several messages sent in a row.");
    } else if (snapshot.presence.trailingYours >= 2) {
      lines.push("Still no response.");
    } else {
      lines.push("Still no response.");
    }
  }

  // ── Section 3: 消息流 ──
  // 最近对话——LLM 理解当前讨论和参与者
  if (snapshot.timeline.lines.length > 0) {
    lines.push("");
    lines.push("## Recent activity");
    for (const line of snapshot.timeline.lines) {
      lines.push(line);
    }
  }

  // ── Section 4: 对话状态（directed + topic）──
  // directed 标记告诉 LLM 是否有人在等她回复
  if (snapshot.groupMeta?.directed) {
    lines.push("");
    lines.push("Someone directed a message at you.");
  }
  if (snapshot.groupMeta?.topic) {
    lines.push("");
    lines.push(`Current topic: ${snapshot.groupMeta.topic}`);
  }

  // ── Section 5: 线程 ──
  // threadId 是功能性的——LLM 需要它调用 topic_advance
  if (snapshot.threads.length > 0) {
    lines.push("");
    lines.push(
      `Open topics: ${JSON.stringify(snapshot.threads.map((t) => ({ id: t.threadId, title: t.title })))}`,
    );
  }

  // ── Section 6: 行动反馈 ──
  // LLM 理解上一轮行动的结果
  for (const fb of snapshot.feedback) {
    lines.push("");
    lines.push(fb.text);
  }

  // ── 层① 对话回顾 ──
  // LLM 用回顾理解"之前聊了什么"以保持话题连贯
  if (snapshot.conversationRecap.length > 0) {
    lines.push("");
    lines.push("## Earlier conversation");
    for (const seg of snapshot.conversationRecap) {
      lines.push(`(${seg.timeRange}, ${seg.messageCount} messages)`);
      lines.push(`  ${seg.first}`);
      if (seg.messageCount > 1) lines.push(`  ${seg.last}`);
    }
  }

  // ── 层② 群组黑话 ──
  // LLM 用黑话适配群聊文化
  if (snapshot.jargon.length > 0) {
    lines.push("");
    lines.push("## Local slang");
    for (const j of snapshot.jargon) {
      lines.push(`- "${j.term}" = ${j.meaning}`);
    }
  }

  // ── 层③ 全局感知信号 ──
  // LLM 感知别处发生什么
  if (snapshot.situationSignals.length > 0) {
    lines.push("");
    lines.push("## What's happening");
    for (const sig of snapshot.situationSignals) {
      lines.push(`- ${sig}`);
    }
  }

  // ── 层③ 定时任务 ──
  // LLM 知道有到期任务需要执行
  if (snapshot.scheduledEvents.length > 0) {
    lines.push("");
    lines.push("## Scheduled");
    for (const ev of snapshot.scheduledEvents) {
      lines.push(`- ${ev}`);
    }
  }

  // ── 层③ 风险标记 ──
  // LLM 在有风险时更谨慎
  if (snapshot.riskFlags.length > 0) {
    lines.push("");
    lines.push("## Caution");
    for (const flag of snapshot.riskFlags) {
      lines.push(`- ${flag}`);
    }
  }

  // ── 层④ 日记 ──
  // ADR-155: diary 注入已统一到 diary.mod.ts contribute()（system prompt）。

  // ── 层④ 社交接收度（ADR-156）──
  // 告诉 LLM 当前群对 Alice 的态度，让她自我调节
  if (snapshot.socialReception != null && snapshot.socialReception < -0.2) {
    lines.push("");
    if (snapshot.socialReception < -0.5) {
      lines.push(
        "Someone was annoyed at your recent messages here. Stay back unless directly asked.",
      );
    } else {
      lines.push(
        "Your recent messages here didn't get much response. Be selective about when you speak.",
      );
    }
  }

  // ── 层④ Episode 残留 ──
  // 跨 engagement 连贯性
  if (snapshot.episodeCarryOver) {
    lines.push("");
    lines.push(snapshot.episodeCarryOver);
  }

  // ── 层⑤ 降级行动标志 ──
  // 压力预算不足时限制 LLM 输出
  if (snapshot.isDegraded) {
    lines.push("");
    lines.push("Running low — a reaction or a short line is enough.");
  }

  // ── 层⑤ 当前话题 ──
  // LLM 维持对话连贯性
  if (snapshot.openTopic) {
    lines.push("");
    lines.push(`You were talking about: ${snapshot.openTopic}.`);
  }

  // ── Section 7: 内心低语 ──
  // 从 facet 获取的情境化 whisper，引导 LLM 的行为倾向
  if (snapshot.whisper) {
    lines.push("");
    lines.push(capitalizeFirst(snapshot.whisper));

    // 防复读增强：在 whisper 后注入已发消息提醒
    if (
      snapshot.presence &&
      snapshot.presence.trailingYours >= 1 &&
      snapshot.presence.lastOutgoingAgo
    ) {
      lines.push(
        `Already sent a message ~${snapshot.presence.lastOutgoingAgo} — still waiting for their reply.`,
      );
    }
  }

  return lines.join("\n");
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
