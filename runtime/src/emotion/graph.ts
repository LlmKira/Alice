import { isDbInitialized } from "../db/connection.js";
import { ALICE_SELF } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { listRecentEmotionEvents, writeEmotionEvent } from "./event-store.js";
import { listRecentEmotionRepairEvents, writeEmotionRepairEvent } from "./repair-store.js";
import {
  clampUnit,
  clampValence,
  deriveEmotionControlPatch,
  deriveEmotionState,
  EMOTION_DEFAULTS,
} from "./state.js";
import type {
  EmotionCause,
  EmotionEpisode,
  EmotionKind,
  EmotionRepairEvent,
  EmotionRepairKind,
  EmotionState,
} from "./types.js";

const MAX_TRANSIENT_EPISODES = 32;
const MAX_TRANSIENT_REPAIRS = 32;

interface EmotionEpisodeInput {
  kind: EmotionKind;
  cause: EmotionCause;
  nowMs: number;
  id?: string;
  targetId?: string;
  valence?: number;
  arousal?: number;
  intensity?: number;
  halfLifeMs?: number;
  confidence?: number;
}

interface EmotionRepairInput {
  repairKind: EmotionRepairKind;
  cause: EmotionCause;
  nowMs: number;
  id?: string;
  emotionKind?: EmotionKind;
  targetId?: string;
  strength?: number;
  confidence?: number;
}

function parseEpisodeLedger(raw: unknown): EmotionEpisode[] {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.filter(isEmotionEpisode);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEmotionEpisode) : [];
  } catch {
    return [];
  }
}

function isEmotionEpisode(value: unknown): value is EmotionEpisode {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.kind === "string" &&
    typeof record.valence === "number" &&
    typeof record.arousal === "number" &&
    typeof record.intensity === "number" &&
    typeof record.createdAtMs === "number" &&
    typeof record.halfLifeMs === "number" &&
    typeof record.confidence === "number" &&
    record.cause != null &&
    typeof record.cause === "object"
  );
}

function makeEpisodeId(input: EmotionEpisodeInput): string {
  const summary = "summary" in input.cause ? input.cause.summary : input.kind;
  let hash = 0;
  for (const ch of `${input.kind}:${summary}:${input.nowMs}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return `emotion-${input.kind}-${input.nowMs.toString(36)}-${hash.toString(36)}`;
}

function makeRepairId(input: EmotionRepairInput): string {
  const summary = "summary" in input.cause ? input.cause.summary : input.repairKind;
  let hash = 0;
  for (const ch of `${input.repairKind}:${input.emotionKind ?? "any"}:${summary}:${input.nowMs}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return `emotion-repair-${input.repairKind}-${input.nowMs.toString(36)}-${hash.toString(36)}`;
}

function readTransientEmotionEpisodes(G: WorldModel): EmotionEpisode[] {
  if (!G.has(ALICE_SELF)) return [];
  return parseEpisodeLedger(G.getDynamic(ALICE_SELF, "emotion_episodes"));
}

function readTransientEmotionRepairs(G: WorldModel): EmotionRepairEvent[] {
  if (!G.has(ALICE_SELF)) return [];
  const raw = G.getDynamic(ALICE_SELF, "emotion_repairs");
  if (raw == null || raw === "") return [];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEmotionRepairEvent) : [];
  } catch {
    return [];
  }
}

function writeTransientEmotionEpisodes(G: WorldModel, episodes: readonly EmotionEpisode[]): void {
  if (!G.has(ALICE_SELF)) return;
  const ordered = [...episodes]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, MAX_TRANSIENT_EPISODES)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  G.setDynamic(ALICE_SELF, "emotion_episodes", JSON.stringify(ordered));
}

function writeTransientEmotionRepairs(G: WorldModel, repairs: readonly EmotionRepairEvent[]): void {
  if (!G.has(ALICE_SELF)) return;
  const ordered = [...repairs]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, MAX_TRANSIENT_REPAIRS)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  G.setDynamic(ALICE_SELF, "emotion_repairs", JSON.stringify(ordered));
}

function isEmotionRepairEvent(value: unknown): value is EmotionRepairEvent {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.repairKind === "string" &&
    typeof record.strength === "number" &&
    typeof record.createdAtMs === "number" &&
    typeof record.confidence === "number" &&
    record.cause != null &&
    typeof record.cause === "object"
  );
}

export function readEmotionEpisodes(G: WorldModel, nowMs = Date.now()): EmotionEpisode[] {
  if (!G.has(ALICE_SELF)) return [];
  if (isDbInitialized()) return listRecentEmotionEvents({ nowMs });
  return readTransientEmotionEpisodes(G);
}

export function readEmotionRepairs(G: WorldModel, nowMs = Date.now()): EmotionRepairEvent[] {
  if (!G.has(ALICE_SELF)) return [];
  if (isDbInitialized()) return listRecentEmotionRepairEvents({ nowMs });
  return readTransientEmotionRepairs(G);
}

export function recordEmotionEpisode(
  G: WorldModel,
  input: EmotionEpisodeInput,
): EmotionEpisode | null {
  if (!G.has(ALICE_SELF)) return null;
  const defaults = EMOTION_DEFAULTS[input.kind];
  const episode: EmotionEpisode = {
    id: input.id ?? makeEpisodeId(input),
    kind: input.kind,
    valence: clampValence(input.valence ?? defaults.valence),
    arousal: clampUnit(input.arousal ?? defaults.arousal),
    intensity: clampUnit(input.intensity ?? 0.5),
    targetId: input.targetId,
    cause: input.cause,
    createdAtMs: input.nowMs,
    halfLifeMs: Math.max(1, input.halfLifeMs ?? defaults.halfLifeMs),
    confidence: clampUnit(input.confidence ?? 0.7),
  };
  if (isDbInitialized()) {
    writeEmotionEvent(episode);
  } else {
    // Tests and isolated in-memory probes may run without DB initialization.
    // Production authority is emotion_events; this transient cache is not a fact ledger.
    const episodes = readTransientEmotionEpisodes(G);
    writeTransientEmotionEpisodes(G, [...episodes, episode]);
  }
  updateEmotionStateOnGraph(G, input.nowMs);
  return episode;
}

export function recordEmotionRepair(
  G: WorldModel,
  input: EmotionRepairInput,
): EmotionRepairEvent | null {
  if (!G.has(ALICE_SELF)) return null;
  const repair: EmotionRepairEvent = {
    id: input.id ?? makeRepairId(input),
    repairKind: input.repairKind,
    emotionKind: input.emotionKind,
    targetId: input.targetId,
    strength: clampUnit(input.strength ?? 0.5),
    cause: input.cause,
    createdAtMs: input.nowMs,
    confidence: clampUnit(input.confidence ?? 0.7),
  };
  if (isDbInitialized()) {
    writeEmotionRepairEvent(repair);
  } else {
    const repairs = readTransientEmotionRepairs(G);
    writeTransientEmotionRepairs(G, [...repairs, repair]);
  }
  updateEmotionStateOnGraph(G, input.nowMs);
  return repair;
}

export function readEmotionState(G: WorldModel, nowMs: number): EmotionState {
  return deriveEmotionState(readEmotionEpisodes(G, nowMs), nowMs, readEmotionRepairs(G, nowMs));
}

export function readEmotionControlPatch(G: WorldModel, nowMs: number) {
  return deriveEmotionControlPatch(readEmotionState(G, nowMs));
}

export function updateEmotionStateOnGraph(G: WorldModel, nowMs: number): EmotionState {
  const state = readEmotionState(G, nowMs);
  if (G.has(ALICE_SELF)) {
    G.setDynamic(ALICE_SELF, "emotion_state", JSON.stringify(state));
    G.setDynamic(ALICE_SELF, "emotion_control", JSON.stringify(deriveEmotionControlPatch(state)));
  }
  return state;
}
