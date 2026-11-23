import type { ChatReading } from "../mechanisms/pressure/will.js";
import type { SpeechRequest } from "../mind/effects.js";
import type { SpeechModelName } from "./speech-model.js";

type ModelTier = "peak" | "routine";

export interface ModelTierDecision {
  tier: ModelTier;
  model: SpeechModelName;
  reasons: string[];
}

export interface ModelTierOptions {
  /** 常规闲聊模型（省钱），默认 flash-lite；生产对照可设为 flash-3.8。 */
  routineModel?: SpeechModelName;
  /** 高光/高情绪密度时刻使用的强模型，默认 flash-3.8。 */
  peakModel?: SpeechModelName;
  /** 从外部传入的心境偏移 valence - home（可选，不传则退回读提示词里的 mood/state 信号）。 */
  valenceShift?: number;
  /** 从意愿层直接读到的会话读数（可选）。 */
  reading?: ChatReading;
}

const BURST_WINDOW_MS = 10 * 60_000;
const INTIMATE_MARKERS = ["几乎天天聊", "常聊", "老朋友", "很亲近", "挚友"];
const PEAK_MOOD_MARKERS = [
  "难过",
  "委屈",
  "伤心",
  "崩溃",
  "气",
  "心疼",
  "开心",
  "激动",
  "想你",
  "别回",
  "别理",
];
const DISTRESS_BURST_MARKERS = [
  "救命",
  "崩了",
  "好想哭",
  "难受",
  "出事",
  "急诊",
  "被裁",
  "分手",
  "对不起",
];

/** 意愿层读数里值得切强模型的几样：对这段关系有抵触、私聊里欠着回应、谨慎和想说的在打架。 */
function readingReasons(reading: ChatReading, chatType: SpeechRequest["chatType"]): string[] {
  const reasons: string[] = [];
  if (reading.raw.aversion > 0.25) reasons.push("relation_aversion");
  if (reading.raw.obligation > 0.7 && chatType === "private") {
    reasons.push("private_high_obligation");
  }
  if (reading.voices.caution >= 0.4) reasons.push("caution_conflict");
  return reasons;
}

/**
 * 发言模型按时刻分强弱（PLAN 第 50 件，北极星「省钱靠少叫，分场景使用模型」）：
 * 平时群聊水群/低张力接话走轻量省钱模型；亲密私聊、情绪峰值、冲突/委屈/道歉或高求助时刻自动切给强模型。
 * 纯函数，不写死业务回复，只从现有结构与上下文读数判断此刻值不值得切强模型。
 */
export function selectSpeechModel(
  request: Pick<SpeechRequest, "chatType" | "timeline" | "contributions" | "at">,
  options: ModelTierOptions = {},
): ModelTierDecision {
  const routineModel = options.routineModel ?? "flash-lite";
  const peakModel = options.peakModel ?? "flash-3.8";
  const reasons: string[] = [];

  if (options.valenceShift !== undefined && Math.abs(options.valenceShift) >= 0.3) {
    reasons.push("affect_valence_peak");
  }

  if (options.reading) reasons.push(...readingReasons(options.reading, request.chatType));

  const peopleText = request.contributions
    .filter((c) => c.kind === "people")
    .map(
      (c) =>
        `${c.text}\n${(c.people ?? []).map((p) => `${p.relation ?? ""}${p.facts?.join("") ?? ""}`).join("\n")}`,
    )
    .join("\n");
  if (request.chatType === "private" && INTIMATE_MARKERS.some((m) => peopleText.includes(m))) {
    reasons.push("intimate_private");
  }

  const moodAndState = request.contributions
    .filter((c) => c.kind === "mood" || c.kind === "state" || c.kind === "self")
    .map((c) => c.text)
    .join("\n");
  if (PEAK_MOOD_MARKERS.some((m) => moodAndState.includes(m))) {
    reasons.push("mood_or_diary_peak");
  }

  const recentIncoming = request.timeline.filter(
    (e) => e.sender && request.at - e.at <= BURST_WINDOW_MS,
  );
  if (request.chatType === "private" && recentIncoming.length >= 3) {
    reasons.push("private_burst");
  }
  const recentText = recentIncoming.map((e) => e.text ?? "").join("\n");
  if (DISTRESS_BURST_MARKERS.some((m) => recentText.includes(m))) {
    reasons.push("emotional_or_crisis_cue");
  }

  const tier: ModelTier = reasons.length > 0 ? "peak" : "routine";
  return {
    tier,
    model: tier === "peak" ? peakModel : routineModel,
    reasons,
  };
}
