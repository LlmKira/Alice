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
import { localNow } from "../../telegram/apps/shared.js";

export function renderPrivate(snapshot: UserPromptSnapshot): string {
  const lines: string[] = [];

  // ADR-237: 从 chatTargetType 判断是否 Bot 场景
  const isBot = snapshot.chatTargetType === "private_bot";

  // ── Section 1: 时间 + 心情 + 对话对象 ──
  // LLM 需要知道对方是谁、关系如何，来调整语气和亲密度
  // ADR-34: 使用配置的时区，而非系统时区
  const now = localNow(snapshot.timezoneOffset);
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  const timeStr = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;

  // Bot 场景：简化 header，不渲染关系/心情/画像
  if (isBot) {
    const targetLabel = snapshot.target
      ? `Interacting with ${snapshot.target.displayName} (bot)`
      : "Interacting with a bot";
    lines.push(`${timeStr}. ${targetLabel}. Current mood: ${snapshot.moodLabel}.`);
  } else {
    const targetLabel = snapshot.target
      ? `Talking to ${snapshot.target.displayName}`
      : "In a private chat";
    const relPart = snapshot.relationshipDesc ? ` (${snapshot.relationshipDesc})` : "";

    // 层② 联系人心情——整合到 Section 1
    const moodPart = snapshot.contactMood ? ` They seem ${snapshot.contactMood}.` : "";
    lines.push(
      `${timeStr}. ${targetLabel}${relPart}. Current mood: ${snapshot.moodLabel}.${moodPart}`,
    );

    // 层② 联系人画像——整合到 Section 1
    if (snapshot.contactProfile) {
      const parts: string[] = [];
      if (snapshot.contactProfile.portrait) parts.push(snapshot.contactProfile.portrait);
      if (snapshot.contactProfile.bio)
        parts.push(`Bio: ${snapshot.contactProfile.bio.slice(0, 80)}`);
      if (snapshot.contactProfile.traits.length > 0)
        parts.push(`Traits: ${snapshot.contactProfile.traits.join(", ")}`);
      if (snapshot.contactProfile.interests.length > 0)
        parts.push(`Interests: ${snapshot.contactProfile.interests.join(", ")}`);
      if (parts.length > 0) lines.push(parts.join(". ") + ".");
    }
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
  // 私聊的所有消息都 directed at you
  if (snapshot.timeline.lines.length > 0) {
    lines.push("");
    lines.push("## Recent activity (private chat — all directed at you)");
    for (const line of snapshot.timeline.lines) {
      lines.push(line);
    }
  }

  // ── Section 4: 对话状态 ──
  // （已在 Section 2 的 Conversation State 中覆盖）

  // ── Section 5: 线程 ──
  // threadId 是功能性的——LLM 需要它调用 topic_advance
  if (snapshot.threads.length > 0) {
    lines.push("");
    lines.push(
      `Open topics: ${JSON.stringify(snapshot.threads.map((t) => ({ id: t.threadId, title: t.title })))}`,
    );
  }

  // ── Section 6: 行动反馈 ──
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
  if (snapshot.scheduledEvents.length > 0) {
    lines.push("");
    lines.push("## Scheduled");
    for (const ev of snapshot.scheduledEvents) {
      lines.push(`- ${ev}`);
    }
  }

  // ── 层③ 风险标记 ──
  if (snapshot.riskFlags.length > 0) {
    lines.push("");
    lines.push("## Caution");
    for (const flag of snapshot.riskFlags) {
      lines.push(`- ${flag}`);
    }
  }

  // ── 层④ 日记 ──
  // ADR-225: diary 注入已统一到 diary.mod.ts contribute()（system prompt）。

  // ── 层④ Episode 残留 ──
  if (snapshot.episodeCarryOver) {
    lines.push("");
    lines.push(snapshot.episodeCarryOver);
  }

  // ── 层⑤ 降级行动标志 ──
  if (snapshot.isDegraded) {
    lines.push("");
    lines.push("Running low — a reaction or a short line is enough.");
  }

  // ── 层⑤ 当前话题 ──
  if (snapshot.openTopic) {
    lines.push("");
    lines.push(`You were talking about: ${snapshot.openTopic}.`);
  }

  // ── Section 7: 内心低语 ──
  // 从 facet 获取的情境化 whisper + 防复读增强
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
