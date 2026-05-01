/**
 * ADR-248 W4: Rendered Context (RC) + Turn Response (TR) timeline merge.
 *
 * This is a provider-neutral fixture seam. It does not replace the current
 * prompt path yet; it defines the ordering contract W4 will later use for
 * compaction and provider-boundary work.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
import type { RenderedContextSegment } from "../rendering/rendered-context.js";

export type TurnResponseEntry =
  | {
      kind?: "message";
      role: "assistant" | "tool" | "system";
      text: string;
    }
  | {
      kind: "block";
      script: string;
      afterward: string;
      residue?: unknown;
    }
  | {
      kind: "tool_result";
      name: string;
      output: string;
      ok: boolean;
    }
  | {
      kind: "host_restatement";
      summary: string;
      observations: string[];
      completedActions: string[];
      errors: string[];
    };

export interface TurnResponseRecord {
  requestedAtMs: number;
  actionLogId?: number | null;
  entries: TurnResponseEntry[];
}

export type MergedTimelineItem =
  | {
      kind: "rc";
      timestampMs: number | null;
      segment: RenderedContextSegment;
    }
  | {
      kind: "tr";
      timestampMs: number;
      turn: TurnResponseRecord;
    };

const timestampForSort = (item: MergedTimelineItem): number =>
  item.timestampMs ?? Number.NEGATIVE_INFINITY;

export function mergeRenderedContextAndTurns(
  rc: readonly RenderedContextSegment[],
  trs: readonly TurnResponseRecord[],
): MergedTimelineItem[] {
  const items: MergedTimelineItem[] = [
    ...rc.map((segment) => ({ kind: "rc" as const, timestampMs: segment.receivedAtMs, segment })),
    ...trs.map((turn) => ({ kind: "tr" as const, timestampMs: turn.requestedAtMs, turn })),
  ];

  return items.sort((a, b) => {
    const byTime = timestampForSort(a) - timestampForSort(b);
    if (byTime !== 0) return byTime;
    if (a.kind === b.kind) return 0;
    // RC before TR on equal timestamp: context that caused the turn must precede the turn.
    return a.kind === "rc" ? -1 : 1;
  });
}

export function renderTurnEntry(entry: TurnResponseEntry): string {
  if (entry.kind === "block") {
    return `assistant:block afterward=${entry.afterward}\n${entry.script}`;
  }
  if (entry.kind === "tool_result") {
    return `tool:${entry.name} ok=${entry.ok}\n${entry.output}`;
  }
  if (entry.kind === "host_restatement") {
    const observations = entry.observations.length > 0
      ? ` observations=${JSON.stringify(entry.observations)}`
      : "";
    const completed = entry.completedActions.length > 0
      ? ` completed=${JSON.stringify(entry.completedActions)}`
      : "";
    const errors = entry.errors.length > 0 ? ` errors=${JSON.stringify(entry.errors)}` : "";
    return `system:host ${entry.summary}${observations}${completed}${errors}`;
  }
  return `${entry.role}:${entry.text}`;
}

export function mergedTimelineToText(items: readonly MergedTimelineItem[]): string {
  return items
    .map((item) => {
      if (item.kind === "rc") return `user:${item.segment.text}`;
      return item.turn.entries.map(renderTurnEntry).join("\n");
    })
    .join("\n");
}
