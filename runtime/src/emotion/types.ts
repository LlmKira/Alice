/**
 * ADR-268: Emotion Episode State.
 *
 * 这里定义 self affect 的内部事实/状态类型。群聊或联系人 mood 仍属于
 * observer 的外部情绪观察，不在这个模块里退休。
 *
 * @see docs/adr/268-emotion-episode-state/README.md
 */

export const EMOTION_KINDS = [
  "pleased",
  "touched",
  "shy",
  "lonely",
  "hurt",
  "uneasy",
  "annoyed",
  "tired",
  "flat",
] as const;

export type EmotionKind = (typeof EMOTION_KINDS)[number];

export type EmotionCause =
  | { type: "message"; messageLogId?: number; summary: string }
  | { type: "action_result"; actionLogId?: number; summary: string }
  | { type: "silence"; targetId: string; summary: string }
  | { type: "overload"; summary: string }
  | { type: "memory"; factId?: string; summary: string }
  | { type: "feedback"; evidenceId?: string; summary: string };

export interface EmotionEpisode {
  id: string;
  kind: EmotionKind;
  valence: number;
  arousal: number;
  intensity: number;
  targetId?: string;
  cause: EmotionCause;
  createdAtMs: number;
  halfLifeMs: number;
  confidence: number;
}

export type ActiveEmotion = EmotionEpisode & {
  effectiveIntensity: number;
  ageMs: number;
};

export interface EmotionState {
  dominant: ActiveEmotion | null;
  secondary: ActiveEmotion | null;
  updatedAtMs: number;
}

export type EmotionRepairKind =
  | "apology"
  | "warm_clarification"
  | "warm_return"
  | "successful_repair";

export interface EmotionRepairEvent {
  id: string;
  repairKind: EmotionRepairKind;
  emotionKind?: EmotionKind;
  targetId?: string;
  strength: number;
  cause: EmotionCause;
  createdAtMs: number;
  confidence: number;
}

export interface EmotionControlPatch {
  voiceBias: {
    sociability: number;
    caution: number;
    reflection: number;
  };
  actionCaps: {
    proactiveMessages: number | null;
  };
  styleBudget: {
    maxCharsMultiplier: number;
    preferShort: boolean;
    allowVulnerability: boolean;
    avoidSelfProof: boolean;
    avoidCruelty: boolean;
  };
}
