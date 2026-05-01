/**
 * ADR-248 W4: append-only compaction summary seam.
 *
 * Summaries are derived projection facts: adding one never deletes RC/TR facts.
 * Ignoring the latest summary is a rollback strategy.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import type { MergedTimelineItem } from "../merge/rc-tr-merge.js";

export interface CompactionSummary {
  id: string;
  createdAtMs: number;
  /** Covers timeline items with timestamp < cursorMs. */
  cursorMs: number;
  summary: string;
  sourceItemCount: number;
  modelName: string | null;
}

export interface CompactedTimeline {
  summary: CompactionSummary | null;
  items: MergedTimelineItem[];
}

export function latestApplicableSummary(
  summaries: readonly CompactionSummary[],
): CompactionSummary | null {
  if (summaries.length === 0) return null;
  return [...summaries].sort((a, b) => b.createdAtMs - a.createdAtMs || b.cursorMs - a.cursorMs)[0] ?? null;
}

export function applyCompactionSummary(
  items: readonly MergedTimelineItem[],
  summaries: readonly CompactionSummary[],
): CompactedTimeline {
  const summary = latestApplicableSummary(summaries);
  if (!summary) return { summary: null, items: [...items] };

  return {
    summary,
    items: items.filter((item) => item.timestampMs == null || item.timestampMs >= summary.cursorMs),
  };
}

export function renderCompactedTimeline(timeline: CompactedTimeline): string {
  const summary = timeline.summary
    ? `<summary cursor="${timeline.summary.cursorMs}" items="${timeline.summary.sourceItemCount}">${timeline.summary.summary}</summary>`
    : null;
  const rest = timeline.items.map((item) => `${item.kind}:${item.timestampMs ?? "unknown"}`);
  return [summary, ...rest].filter(Boolean).join("\n");
}
