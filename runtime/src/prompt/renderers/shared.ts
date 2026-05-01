import { PromptBuilder } from "../../core/prompt-style.js";
import type { FeedbackSlot, PresenceSlot, RecapSegment, ThreadSlot } from "../types.js";

export type PromptBlock = readonly string[];

export function renderLocalClock(nowMs: number, timezoneOffset: number): string {
  const now = new Date(nowMs + timezoneOffset * 60 * 60 * 1000);
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function rawBlock(...lines: Array<string | null | undefined>): PromptBlock {
  return lines.filter((line): line is string => line != null && line.length > 0);
}

export function joinBlocks(blocks: readonly PromptBlock[]): string {
  const nonEmptyBlocks = blocks.filter((block) => block.length > 0);
  return nonEmptyBlocks.map((block) => block.join("\n")).join("\n\n");
}

function buildBlock(render: (builder: PromptBuilder) => void): PromptBlock {
  const builder = new PromptBuilder();
  render(builder);
  return builder.build();
}

export function sectionBlock(title: string, lines: readonly string[]): PromptBlock {
  if (lines.length === 0) return [];
  return buildBlock((builder) => {
    builder.heading(title);
    for (const line of lines) {
      builder.line(line);
    }
  });
}

export function listSectionBlock(title: string, items: readonly string[]): PromptBlock {
  if (items.length === 0) return [];
  return buildBlock((builder) => {
    builder.heading(title);
    builder.list([...items]);
  });
}

export function conversationStateBlock(presence?: PresenceSlot): PromptBlock {
  if (!presence || presence.trailingYours < 1 || !presence.lastOutgoingPreview) return [];
  return buildBlock((builder) => {
    builder.heading("Conversation State");
    builder.line(`Replied ~${presence.lastOutgoingAgo}: "${presence.lastOutgoingPreview}"`);
    if (presence.trailingYours >= 3) {
      builder.line("Still no response. Several messages sent in a row.");
    } else {
      builder.line("Still no response.");
    }
  });
}

export function openTopicsBlock(threads: readonly ThreadSlot[]): PromptBlock {
  if (threads.length === 0) return [];
  return buildBlock((builder) => {
    builder.heading("Open topics");
    builder.list(threads.map((thread) => `#${thread.threadId} "${thread.title}"`));
  });
}

export function feedbackBlocks(feedback: readonly FeedbackSlot[]): PromptBlock[] {
  return feedback.map((item) => rawBlock(item.text)).filter((block) => block.length > 0);
}

export function recapBlock(segments: readonly RecapSegment[]): PromptBlock {
  if (segments.length === 0) return [];
  return buildBlock((builder) => {
    builder.heading("Earlier conversation");
    for (const segment of segments) {
      builder.line(`(${segment.timeRange}, ${segment.messageCount} messages)`);
      builder.line(segment.first);
      if (segment.messageCount > 1) {
        builder.line(segment.last);
      }
    }
  });
}

export function whisperBlock(whisper: string, presence?: PresenceSlot): PromptBlock {
  if (!whisper) return [];
  return rawBlock(capitalizeFirst(whisper), waitingForReplyLine(presence));
}

export function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

function waitingForReplyLine(presence?: PresenceSlot): string | null {
  if (!presence || presence.trailingYours < 1 || !presence.lastOutgoingAgo) return null;
  return `Already sent a message ~${presence.lastOutgoingAgo} — still waiting for their reply.`;
}
