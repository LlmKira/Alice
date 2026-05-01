/**
 * Shared parser for narrative_threads.involves.
 *
 * The DB field may contain old display strings or raw handles. Lifecycle and
 * diagnostics must only treat typed graph node IDs as effective involvement.
 *
 * @see docs/adr/262-social-case-management/README.md
 */

export interface ThreadInvolvement {
  nodeId: string;
  role?: string;
  facts?: string[];
}

interface RawThreadInvolvement {
  nodeId?: unknown;
  role?: unknown;
  facts?: unknown;
}

export function isEffectiveThreadInvolvementNodeId(nodeId: string): boolean {
  return (
    nodeId === "self" ||
    nodeId.startsWith("contact:") ||
    nodeId.startsWith("channel:") ||
    nodeId.startsWith("conversation:")
  );
}

export function parseThreadInvolvements(raw: string | null | undefined): ThreadInvolvement[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item === "string") return makeInvolvement(item, undefined, undefined);
      const rawItem = item as RawThreadInvolvement | null;
      return makeInvolvement(rawItem?.nodeId, rawItem?.role, rawItem?.facts);
    });
  } catch {
    return [];
  }
}

export function parseThreadInvolvementNodeIds(raw: string | null | undefined): string[] {
  return [...new Set(parseThreadInvolvements(raw).map((item) => item.nodeId))].sort();
}

export function hasEffectiveThreadInvolvement(raw: string | null | undefined): boolean {
  return parseThreadInvolvements(raw).some((item) =>
    isEffectiveThreadInvolvementNodeId(item.nodeId),
  );
}

function makeInvolvement(nodeId: unknown, role: unknown, facts: unknown): ThreadInvolvement[] {
  if (typeof nodeId !== "string") return [];
  const normalizedNodeId = nodeId.trim();
  if (normalizedNodeId === "" || normalizedNodeId === "undefined") return [];
  return [
    {
      nodeId: normalizedNodeId,
      role: typeof role === "string" && role.trim() !== "" ? role : undefined,
      facts: Array.isArray(facts)
        ? facts.filter((item): item is string => typeof item === "string")
        : undefined,
    },
  ];
}
