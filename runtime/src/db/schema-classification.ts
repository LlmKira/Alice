/**
 * ADR-248 W2: DB schema classification registry.
 *
 * This is the single lightweight authority for table-level data semantics.
 * It prevents schema comments, ADR data maps, and implementation code from
 * drifting into three separate stories.
 *
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 * @see docs/adr/248-dcp-reference-implementation-plan/data-map.md
 */
export type SchemaDataClass =
  | "fact"
  | "audit_fact"
  | "projection"
  | "snapshot"
  | "state"
  | "projection_snapshot"
  | "legacy_mixed";

export type Rebuildability = "yes" | "partially" | "no" | "unknown";

export interface TableClassification {
  /** Table name in SQLite. */
  table: string;
  /** Exported symbol name in schema.ts. */
  exportName: string;
  /** ADR-248 semantic class. */
  class: SchemaDataClass;
  /** Append-only means normal writes should INSERT, not rewrite history. */
  appendOnly: boolean;
  /** Whether the table can be rebuilt from lower-level facts in the target architecture. */
  rebuildable: Rebuildability;
  /** One-line authority statement for humans and reviewers. */
  authority: string;
  /** Current write boundary; keep concrete enough for code search. */
  writer: string;
  /** Current read surfaces; keep coarse to avoid churn. */
  readers: string;
  /** Absence/nullability semantics at table level. */
  absence: string;
}

export const TABLE_CLASSIFICATIONS = {
  graphSnapshots: {
    table: "graph_snapshots",
    exportName: "graphSnapshots",
    class: "snapshot",
    appendOnly: true,
    rebuildable: "partially",
    authority: "Startup recovery checkpoint; not the reason why graph state changed.",
    writer: "runtime/src/db/snapshot.ts",
    readers: "runtime/src/db/snapshot.ts",
    absence: "No row means cold start must build/load graph from other available sources.",
  },
  tickLog: {
    table: "tick_log",
    exportName: "tickLog",
    class: "legacy_mixed",
    appendOnly: true,
    rebuildable: "partially",
    authority: "Historical tick-level pressure and gate verdict audit.",
    writer: "runtime/src/engine/evolve.ts",
    readers: "diagnostics/anomaly/manual SQL",
    absence: "No row means this tick produced no persisted non-skip tick audit.",
  },
  actionLog: {
    table: "action_log",
    exportName: "actionLog",
    class: "legacy_mixed",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical ACT result audit after host execution.",
    writer: "runtime/src/engine/react/feedback-arc.ts",
    readers: "diagnostics/relationship trajectory/anomaly",
    absence: "No row means ACT did not finalize a result for that queued item.",
  },
  silenceLog: {
    table: "silence_log",
    exportName: "silenceLog",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical EVOLVE silence exit audit.",
    writer: "runtime/src/engine/evolve.ts",
    readers: "runtime/src/diagnostics/silence-quality.ts",
    absence: "No row means no explicit silence exit was persisted for that tick.",
  },
  decisionTrace: {
    table: "decision_trace",
    exportName: "decisionTrace",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical explanation of one EVOLVE/ACT decision; never control input.",
    writer: "runtime/src/db/decision-trace.ts",
    readers: "runtime/src/diagnostics/decision-trace.ts",
    absence: "No row means the decision path has not been instrumented or did not run.",
  },
  tickTrace: {
    table: "tick_trace",
    exportName: "tickTrace",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "partially",
    authority:
      "ADR-258 tick-boundary observation authority for pressure and decision phase replay.",
    writer: "runtime/src/db/observation-spine.ts via runtime/src/engine/evolve.ts",
    readers: "diagnostics/iaus-frequency-audit/manual SQL",
    absence: "No row means this tick has no typed observation boundary.",
  },
  candidateTrace: {
    table: "candidate_trace",
    exportName: "candidateTrace",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "partially",
    authority: "ADR-258 candidate and silence counterfactual authority.",
    writer: "runtime/src/db/observation-spine.ts via runtime/src/engine/evolve.ts",
    readers: "diagnostics/iaus-frequency-audit/manual SQL",
    absence: "No row means the tick candidate was not instrumented or no candidate existed.",
  },
  queueTrace: {
    table: "queue_trace",
    exportName: "queueTrace",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "ADR-258 typed enqueue and queue fate authority.",
    writer:
      "runtime/src/db/observation-spine.ts via runtime/src/engine/evolve.ts and act scheduler",
    readers: "diagnostics/iaus-frequency-audit/manual SQL",
    absence: "No row means the queue attempt or fate was not instrumented.",
  },
  actionResult: {
    table: "action_result",
    exportName: "actionResult",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "ADR-258 typed ACT executor result authority.",
    writer: "runtime/src/db/observation-spine.ts via runtime/src/engine/react/feedback-arc.ts",
    readers: "diagnostics/iaus-frequency-audit/manual SQL",
    absence: "No row means ACT did not finalize a typed result for that queue item.",
  },
  focusTransitionShadow: {
    table: "focus_transition_shadow",
    exportName: "focusTransitionShadow",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "partially",
    authority:
      "Structured shadow evidence for possible focus transitions, including rejected active cross-chat sends, remote observations, and forwarded shares.",
    writer:
      "runtime/src/db/focus-transition-shadow.ts via runtime/src/engine/react/feedback-arc.ts",
    readers: "runtime/src/diagnostics/execution-conversion.ts",
    absence: "No row means no structured shadow transition evidence was emitted for that action.",
  },
  focusTransitionIntent: {
    table: "focus_transition_intent",
    exportName: "focusTransitionIntent",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority:
      "ADR-259 Wave 3 explicit or blocked no-side-effect transition request fact; diagnostic only, not send authorization.",
    writer:
      "runtime/src/db/focus-transition-intent.ts via self attention-pull, self switch-chat, and blocked cross-chat send boundary",
    readers: "runtime/src/diagnostics/execution-conversion.ts",
    absence:
      "No row means Alice did not explicitly record a transition request and no blocked cross-chat send request was captured.",
  },
  factMutation: {
    table: "fact_mutation",
    exportName: "factMutation",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "partially",
    authority: "ADR-258 typed fact writeback authority after action or decay source.",
    writer: "runtime/src/db/observation-spine.ts via ACT/EVOLVE boundaries",
    readers: "diagnostics/iaus-frequency-audit/manual SQL",
    absence:
      "No row means no fact mutation has been recorded; explicit no-op uses mutation_kind=none.",
  },
  pressureDelta: {
    table: "pressure_delta",
    exportName: "pressureDelta",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "partially",
    authority: "ADR-258 next-window pressure release authority.",
    writer: "runtime/src/db/observation-spine.ts via runtime/src/engine/evolve.ts",
    readers: "diagnostics/iaus-frequency-audit/manual SQL",
    absence: "No row means no next-window pressure comparison has been recorded.",
  },
  personalitySnapshots: {
    table: "personality_snapshots",
    exportName: "personalitySnapshots",
    class: "snapshot",
    appendOnly: true,
    rebuildable: "partially",
    authority: "Recovery checkpoint for the latest personality vector.",
    writer: "runtime/src/db/snapshot.ts",
    readers: "startup/eval/diagnostics",
    absence: "No row means use configured initial personality vector.",
  },
  canonicalEvents: {
    table: "canonical_events",
    exportName: "canonicalEvents",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Stable canonical event fact stream for deterministic replay.",
    writer: "runtime/src/telegram/events.ts via runtime/src/db/canonical-event-store.ts",
    readers: "DCP replay diagnostics, prompt-log shadow, prompt compare diagnostics",
    absence: "No row means no canonical fact has been persisted for that event.",
  },
  messageLog: {
    table: "message_log",
    exportName: "messageLog",
    class: "legacy_mixed",
    appendOnly: true,
    rebuildable: "partially",
    authority: "Legacy prompt/memory/reply-cache store; not canonical replay authority.",
    writer: "runtime/src/telegram/events.ts and runtime/src/mods/memory.mod.ts",
    readers: "prompt snapshot/memory queries/reply cache",
    absence: "No row means no persisted message observation for that chat/tick.",
  },
  albumPhotos: {
    table: "album_photos",
    exportName: "albumPhotos",
    class: "projection",
    appendOnly: false,
    rebuildable: "partially",
    authority:
      "Addressable group-photo album projection derived from observed Telegram photo facts and media semantic caches.",
    writer: "runtime/src/db/album.ts and runtime/src/telegram/events.ts",
    readers: "album search/send CLI and Engine API",
    absence:
      "No row means Alice has no reusable group-photo asset for that file_unique_id/source message.",
  },
  albumUsage: {
    table: "album_usage",
    exportName: "albumUsage",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Append-only fact stream of album send attempts and outcomes.",
    writer: "runtime/src/db/album.ts",
    readers: "album feedback loop, diagnostics, repeat suppression",
    absence: "No row means no album send attempt has been recorded for that asset/target.",
  },
  rhythmProfiles: {
    table: "rhythm_profiles",
    exportName: "rhythmProfiles",
    class: "projection",
    appendOnly: false,
    rebuildable: "yes",
    authority:
      "Current semantic timing projection derived from message/canonical event facts; not historical activity authority.",
    writer: "runtime/scripts/rebuild-rhythm-profiles.ts",
    readers: "timing diagnostics, future prompt timing projection, future IAUS U_timing shadow",
    absence:
      "No row means no rhythm projection has been built for that entity; treat timing as unknown.",
  },
  interventionOutcomeEvidence: {
    table: "intervention_outcome_evidence",
    exportName: "interventionOutcomeEvidence",
    class: "fact",
    appendOnly: true,
    rebuildable: "partially",
    authority:
      "Per Alice outbound message intervention outcome evidence before social_reception projection mutation.",
    writer: "runtime/src/mods/observer/group-reception.ts",
    readers: "social_reception projection update/ADR-254 target projection diagnostics",
    absence: "No row means that Alice outbound message has not been evaluated for group reception.",
  },
  emotionEvents: {
    table: "emotion_events",
    exportName: "emotionEvents",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority:
      "Append-only Alice self emotion episode facts; graph emotion_state is a rebuildable projection/cache.",
    writer: "runtime/src/emotion/event-store.ts via runtime/src/emotion/graph.ts",
    readers: "runtime/src/emotion/event-store.ts and emotion projection/control diagnostics",
    absence: "No row means no persisted self emotion episode has been recorded.",
  },
  emotionRepairs: {
    table: "emotion_repairs",
    exportName: "emotionRepairs",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority:
      "Append-only Alice self emotion repair facts that accelerate derived decay without mutating episode facts.",
    writer: "runtime/src/emotion/repair-store.ts via ADR-268 structured appraisal producers",
    readers: "runtime/src/emotion/repair-store.ts and EmotionState projection",
    absence: "No row means no persisted repair accelerator has been recorded.",
  },
  socialEvents: {
    table: "social_events",
    exportName: "socialEvents",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority:
      "Append-only social case event facts with optional stable case_id; repair state, venue debt, and boundary state are projections.",
    writer: "runtime/src/db/social-case.ts",
    readers: "runtime/src/social-case/projector.ts and future social case diagnostics",
    absence:
      "No row means no typed social event has been recorded for that relation or venue; null case_id means legacy relation-scoped case projection.",
  },
  narrativeThreads: {
    table: "narrative_threads",
    exportName: "narrativeThreads",
    class: "projection",
    appendOnly: false,
    rebuildable: "partially",
    authority: "Current open/resolved thread read model for prompt and pressure.",
    writer: "thread/episode mods",
    readers: "prompt/context/pressure diagnostics",
    absence: "No row means no active persisted narrative thread.",
  },
  threadLifecycleEvent: {
    table: "thread_lifecycle_event",
    exportName: "threadLifecycleEvent",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority:
      "Append-only reason a narrative thread was resolved, renewed, snoozed, or expired unresolved.",
    writer: "thread lifecycle maintenance and thread instructions",
    readers: "P4 lifecycle diagnostics and ADR-262 thread lifecycle follow-up",
    absence: "No row means no typed lifecycle outcome has been recorded for that thread.",
  },
  modStates: {
    table: "mod_states",
    exportName: "modStates",
    class: "state",
    appendOnly: false,
    rebuildable: "unknown",
    authority: "Current per-mod runtime state checkpoint.",
    writer: "runtime/src/core/dispatcher.ts",
    readers: "runtime/src/core/dispatcher.ts",
    absence: "No row means the mod starts from its declared initial state.",
  },
  graphNodes: {
    table: "graph_nodes",
    exportName: "graphNodes",
    class: "projection_snapshot",
    appendOnly: false,
    rebuildable: "partially",
    authority: "Current WorldModel node cache for runtime recovery.",
    writer: "runtime/src/db/snapshot.ts",
    readers: "runtime/src/db/snapshot.ts",
    absence: "Missing node means it is absent from the current graph projection.",
  },
  graphEdges: {
    table: "graph_edges",
    exportName: "graphEdges",
    class: "projection_snapshot",
    appendOnly: false,
    rebuildable: "partially",
    authority: "Current WorldModel edge cache for runtime recovery.",
    writer: "runtime/src/db/snapshot.ts",
    readers: "runtime/src/db/snapshot.ts",
    absence: "Missing edge means no current relation in the graph projection.",
  },
  scheduledTasks: {
    table: "scheduled_tasks",
    exportName: "scheduledTasks",
    class: "state",
    appendOnly: false,
    rebuildable: "no",
    authority: "Current scheduler task list.",
    writer: "runtime/src/mods/scheduler.mod.ts",
    readers: "runtime/src/mods/scheduler.mod.ts",
    absence: "No active row means no scheduled task is pending.",
  },
  narrativeBeats: {
    table: "narrative_beats",
    exportName: "narrativeBeats",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical beat facts attached to narrative threads.",
    writer: "thread/episode mods",
    readers: "thread synthesis/prompt context",
    absence: "No beat row means no persisted beat for that thread moment.",
  },
  personalityEvolutionLog: {
    table: "personality_evolution_log",
    exportName: "personalityEvolutionLog",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical explanation for personality vector changes.",
    writer: "runtime/src/engine/react/feedback-arc.ts and personality paths",
    readers: "diagnostics/manual SQL",
    absence: "No row means no persisted attribution for that personality change.",
  },
  diaryEntries: {
    table: "diary_entries",
    exportName: "diaryEntries",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Alice-authored subjective memory facts.",
    writer: "runtime/src/mods/diary.mod.ts",
    readers: "diary prompt contribution",
    absence: "No row means Alice has not written a diary entry for that moment/topic.",
  },
  auditEvents: {
    table: "audit_events",
    exportName: "auditEvents",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical runtime warning/error/fatal events.",
    writer: "runtime/src/db/audit.ts",
    readers: "anomaly/manual SQL",
    absence: "No row means no persisted audit event matching the query.",
  },
  deferredOutcomeLog: {
    table: "deferred_outcome_log",
    exportName: "deferredOutcomeLog",
    class: "audit_fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical delayed external feedback evaluations.",
    writer: "runtime/src/engine/deferred-outcome.ts",
    readers: "closure diagnostics/behavioral audit",
    absence: "No row means no delayed evaluation has been recorded.",
  },
  stickerPalette: {
    table: "sticker_palette",
    exportName: "stickerPalette",
    class: "state",
    appendOnly: false,
    rebuildable: "partially",
    authority: "Current sticker semantic palette used for action selection.",
    writer: "sticker sync/admin palette paths",
    readers: "sticker action selection",
    absence: "No row means the sticker is unavailable to semantic lookup.",
  },
  stickerUsage: {
    table: "sticker_usage",
    exportName: "stickerUsage",
    class: "projection",
    appendOnly: false,
    rebuildable: "partially",
    authority: "Current aggregate sticker usage by chat.",
    writer: "sticker action paths",
    readers: "sticker selection/diagnostics",
    absence: "No row means no counted usage for that sticker/chat pair.",
  },
  consciousnessEvents: {
    table: "consciousness_events",
    exportName: "consciousnessEvents",
    class: "fact",
    appendOnly: true,
    rebuildable: "no",
    authority: "Historical consciousness stream events surfaced into later prompts.",
    writer: "runtime/src/engine/consciousness.ts",
    readers: "consciousness surface/reinforce paths",
    absence: "No row means no consciousness event was emitted.",
  },
  bioCache: {
    table: "bio_cache",
    exportName: "bioCache",
    class: "snapshot",
    appendOnly: false,
    rebuildable: "yes",
    authority: "TTL cache of Telegram bio/about fetched from platform APIs.",
    writer: "runtime/src/telegram/bio-cache.ts",
    readers: "relationship/profile prompt paths",
    absence: "No row means cache miss; platform fetch may populate later.",
  },
  episodes: {
    table: "episodes",
    exportName: "episodes",
    class: "projection",
    appendOnly: false,
    rebuildable: "partially",
    authority: "Current cognitive episode graph read model.",
    writer: "runtime/src/engine/episode.ts",
    readers: "episode pressure/prompt/diagnostics",
    absence: "No row means no persisted episode for that id/tick.",
  },
} as const satisfies Record<string, TableClassification>;

export type ClassifiedTableExport = keyof typeof TABLE_CLASSIFICATIONS;
