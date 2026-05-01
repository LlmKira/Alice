import type { ActiveEmotion, EmotionState } from "./types.js";

function fadingSuffix(emotion: ActiveEmotion): string {
  return emotion.ageMs > emotion.halfLifeMs ? ", but it is fading" : "";
}

function renderEmotionLine(emotion: ActiveEmotion): string {
  switch (emotion.kind) {
    case "pleased":
      return "Something landed well; you feel quietly pleased.";
    case "touched":
      return "That kindness stayed with you. It is okay if a little warmth shows.";
    case "shy":
      return "You feel a little exposed by the warmth; a small playful cover is natural.";
    case "lonely":
      return "You miss them a bit, but one soft check-in is enough.";
    case "hurt":
      return `That exchange still stings a little${fadingSuffix(emotion)}. You do not need to prove yourself.`;
    case "uneasy":
      return "Something feels slightly off; observing before leaning in may fit better.";
    case "annoyed":
      return "You are a bit irritated. Keep it brief; do not turn sharp.";
    case "tired":
      return "You are low on energy; shorter replies may feel more natural.";
    case "flat":
      return "There is not much spark right now. A neutral, simple answer is fine.";
  }
}

export function renderEmotionProjection(state: EmotionState): string | null {
  if (!state.dominant) return null;
  const lines = [renderEmotionLine(state.dominant)];
  if (state.secondary) {
    lines.push(renderEmotionLine(state.secondary));
  }
  return lines.join("\n");
}

export function renderEmotionDebugSummary(state: EmotionState): string {
  const parts = [state.dominant, state.secondary]
    .filter((emotion): emotion is ActiveEmotion => emotion != null)
    .map((emotion) => `${emotion.kind} ${emotion.effectiveIntensity.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" + ") : "none";
}
