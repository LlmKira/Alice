import type {
  ActiveEmotion,
  EmotionControlPatch,
  EmotionEpisode,
  EmotionKind,
  EmotionRepairEvent,
  EmotionState,
} from "./types.js";

const MIN_ACTIVE_INTENSITY = 0.08;
const SECONDARY_RATIO = 0.45;
const SECONDARY_MIN_INTENSITY = 0.16;

export const EMOTION_DEFAULTS: Record<
  EmotionKind,
  { valence: number; arousal: number; halfLifeMs: number }
> = {
  pleased: { valence: 0.45, arousal: 0.35, halfLifeMs: 45 * 60_000 },
  touched: { valence: 0.55, arousal: 0.35, halfLifeMs: 2 * 60 * 60_000 },
  shy: { valence: 0.25, arousal: 0.55, halfLifeMs: 8 * 60_000 },
  lonely: { valence: -0.45, arousal: 0.35, halfLifeMs: 2 * 60 * 60_000 },
  hurt: { valence: -0.6, arousal: 0.45, halfLifeMs: 3 * 60 * 60_000 },
  uneasy: { valence: -0.35, arousal: 0.55, halfLifeMs: 90 * 60_000 },
  annoyed: { valence: -0.45, arousal: 0.6, halfLifeMs: 45 * 60_000 },
  tired: { valence: -0.3, arousal: 0.15, halfLifeMs: 60 * 60_000 },
  flat: { valence: -0.1, arousal: 0.05, halfLifeMs: 45 * 60_000 },
};

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampValence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

export function effectiveEmotionIntensity(episode: EmotionEpisode, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - episode.createdAtMs);
  const halfLifeMs = Math.max(1, episode.halfLifeMs);
  return clampUnit(episode.intensity) * 0.5 ** (ageMs / halfLifeMs);
}

function repairAppliesToEmotion(repair: EmotionRepairEvent, episode: EmotionEpisode): boolean {
  if (repair.createdAtMs < episode.createdAtMs) return false;
  if (repair.emotionKind && repair.emotionKind !== episode.kind) return false;
  if (repair.targetId && episode.targetId && repair.targetId !== episode.targetId) return false;
  if (repair.targetId && !episode.targetId) return false;
  return true;
}

function repairWeightForEmotion(repair: EmotionRepairEvent, episode: EmotionEpisode): number {
  if (!repairAppliesToEmotion(repair, episode)) return 0;

  switch (episode.kind) {
    case "hurt":
      return repair.repairKind === "apology" ||
        repair.repairKind === "warm_clarification" ||
        repair.repairKind === "successful_repair"
        ? 1
        : 0.35;
    case "lonely":
      return repair.repairKind === "warm_return" || repair.repairKind === "successful_repair"
        ? 1
        : 0.3;
    default:
      return repair.emotionKind === episode.kind ? 0.5 : 0;
  }
}

function repairMultiplier(episode: EmotionEpisode, repairs: readonly EmotionRepairEvent[]): number {
  let retained = 1;
  for (const repair of repairs) {
    const weight = repairWeightForEmotion(repair, episode);
    if (weight <= 0) continue;
    const strength = clampUnit(repair.strength) * clampUnit(repair.confidence) * weight;
    retained *= 1 - Math.min(0.85, strength * 0.65);
  }
  return Math.max(0.05, retained);
}

export function effectiveEmotionIntensityWithRepairs(
  episode: EmotionEpisode,
  nowMs: number,
  repairs: readonly EmotionRepairEvent[],
): number {
  return effectiveEmotionIntensity(episode, nowMs) * repairMultiplier(episode, repairs);
}

export function deriveEmotionState(
  episodes: readonly EmotionEpisode[],
  nowMs: number,
  repairs: readonly EmotionRepairEvent[] = [],
): EmotionState {
  const active = episodes
    .map((episode): ActiveEmotion => {
      const ageMs = Math.max(0, nowMs - episode.createdAtMs);
      return {
        ...episode,
        ageMs,
        effectiveIntensity: effectiveEmotionIntensityWithRepairs(episode, nowMs, repairs),
      };
    })
    .filter((episode) => episode.effectiveIntensity >= MIN_ACTIVE_INTENSITY)
    .sort((a, b) => {
      const delta = b.effectiveIntensity - a.effectiveIntensity;
      return Math.abs(delta) > 1e-9 ? delta : b.createdAtMs - a.createdAtMs;
    });

  const dominant = active[0] ?? null;
  const secondaryCandidate = active.find(
    (episode) => dominant == null || episode.kind !== dominant.kind,
  );
  const secondary =
    dominant &&
    secondaryCandidate &&
    secondaryCandidate.effectiveIntensity >= SECONDARY_MIN_INTENSITY &&
    secondaryCandidate.effectiveIntensity >= dominant.effectiveIntensity * SECONDARY_RATIO
      ? secondaryCandidate
      : null;

  return { dominant, secondary, updatedAtMs: nowMs };
}

function intensityScale(state: EmotionState, kind: EmotionKind): number {
  const dominant = state.dominant?.kind === kind ? state.dominant.effectiveIntensity : 0;
  const secondary = state.secondary?.kind === kind ? state.secondary.effectiveIntensity * 0.6 : 0;
  return Math.max(dominant, secondary);
}

export function deriveEmotionControlPatch(state: EmotionState): EmotionControlPatch {
  const patch: EmotionControlPatch = {
    voiceBias: { sociability: 0, caution: 0, reflection: 0 },
    actionCaps: { proactiveMessages: null },
    styleBudget: {
      maxCharsMultiplier: 1,
      preferShort: false,
      allowVulnerability: false,
      avoidSelfProof: false,
      avoidCruelty: true,
    },
  };

  const touched = intensityScale(state, "touched");
  const shy = intensityScale(state, "shy");
  const hurt = intensityScale(state, "hurt");
  const lonely = intensityScale(state, "lonely");
  const uneasy = intensityScale(state, "uneasy");
  const annoyed = intensityScale(state, "annoyed");
  const tired = intensityScale(state, "tired");
  const flat = intensityScale(state, "flat");
  const pleased = intensityScale(state, "pleased");

  patch.voiceBias.sociability += pleased * 0.08 + touched * 0.12 + lonely * 0.12;
  patch.voiceBias.sociability -= hurt * 0.08 + tired * 0.12 + flat * 0.1 + annoyed * 0.08;
  patch.voiceBias.caution += hurt * 0.2 + uneasy * 0.18 + annoyed * 0.08;
  patch.voiceBias.caution -= pleased * 0.06 + touched * 0.04;
  patch.voiceBias.reflection += uneasy * 0.1 + hurt * 0.08 + flat * 0.06;

  if (lonely > 0) {
    patch.actionCaps.proactiveMessages = 1;
  }

  const shortPressure = tired * 0.35 + annoyed * 0.25 + flat * 0.25 + shy * 0.12 + hurt * 0.08;
  patch.styleBudget.maxCharsMultiplier = Math.max(0.55, 1 - shortPressure);
  patch.styleBudget.preferShort = tired >= 0.25 || annoyed >= 0.25 || flat >= 0.25 || shy >= 0.35;
  patch.styleBudget.allowVulnerability = touched >= 0.2;
  patch.styleBudget.avoidSelfProof = hurt >= 0.2;
  patch.styleBudget.avoidCruelty = true;

  return patch;
}

export function emotionStateMoodSignal(state: EmotionState): number {
  const emotions = [state.dominant, state.secondary].filter((e): e is ActiveEmotion => e != null);
  if (emotions.length === 0) return 0;

  let weighted = 0;
  let weight = 0;
  for (const emotion of emotions) {
    const w = emotion.effectiveIntensity;
    weighted += emotion.valence * w;
    weight += w;
  }
  return weight > 0 ? clampValence(weighted / weight) : 0;
}

export function emotionStateArousalSignal(state: EmotionState): number {
  const emotions = [state.dominant, state.secondary].filter((e): e is ActiveEmotion => e != null);
  if (emotions.length === 0) return 0;

  let weighted = 0;
  let weight = 0;
  for (const emotion of emotions) {
    const w = emotion.effectiveIntensity;
    weighted += emotion.arousal * w;
    weight += w;
  }
  return weight > 0 ? clampUnit(weighted / weight) : 0;
}
