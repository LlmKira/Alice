import { appendFileSync } from "node:fs";
import { AxAI, ax } from "@ax-llm/ax";
import { and, asc, eq, gt, gte, or } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../../config.js";
import { getDb } from "../../db/connection.js";
import { interventionOutcomeEvidence, messageLog } from "../../db/schema.js";
import { appraiseWarmReturnRepair } from "../../emotion/appraisal.js";
import { recordEmotionEpisode } from "../../emotion/graph.js";
import { readSocialReception, readSocialReceptionMs } from "../../graph/dynamic-props.js";
import type { WorldModel } from "../../graph/world-model.js";
import { ALICE_GROUP_RECEPTION_SHADOW_LOG_PATH, ensureParentDir } from "../../runtime-paths.js";
import { createLogger } from "../../utils/logger.js";

// ── ADR-156: 群组社交接收度更新 ─────────────────────────────────────
// 每个 tick 检查 Alice 最近在群组中发言后的接收情况。
// 信号存储在 graph channel node 的 social_reception 动态属性上。
//
// 检测逻辑：
// - 从 message_log 查 Alice 最近在群组中的发言事实
// - 检查该发言之后的群消息中是否有人回复 Alice
// - 检查是否有拒绝关键词
// - 先写 per-intervention evidence，再用 EMA 更新 social_reception
//
// @see docs/adr/156-social-reception-feedback/README.md
// @see docs/adr/255-intervention-outcome-truth-model/README.md

const log = createLogger("observer/reception");

/** 拒绝/敌意关键词。 */
const HOSTILE_KEYWORDS = [
  "谁问你了",
  "闭嘴",
  "烦",
  "傻逼",
  "滚",
  "屏蔽",
  "shut up",
  "nobody asked",
  "block",
  "на русском",
  "говори по-русски",
  "перешла на китайский",
  "на китайский перешла",
];

/** EMA 系数：新信号占 30%。 */
const RECEPTION_ALPHA = 0.3;
/** 无新信号时，每小时自然衰减率。 */
const RECEPTION_HOURLY_DECAY = 0.95;
/** 回溯窗口：检查 Alice 最近 10 分钟的发言。 */
const RECEPTION_LOOKBACK_MS = 10 * 60 * 1000;
/** 候选扫描窗口：给刚过期的发言一次落 unknown_timeout 的机会。 */
const RECEPTION_SCAN_MS = RECEPTION_LOOKBACK_MS * 2;
/** 冷场判定：Alice 发言后 N 条消息无人理。 */
const COLD_THRESHOLD_MSGS = 5;
/** 单 tick 最多评估的 Alice 发言数，防止历史 DB 首次升级时回扫过量。 */
const MAX_ALICE_CANDIDATES = 100;
/** 单条 Alice 发言后最多读取的后续消息数。 */
const MAX_AFTER_MESSAGES = 10;
/** Shadow judge 只做旁路诊断，避免单 tick 大量启动 LLM 请求。 */
const MAX_SHADOW_JUDGE_PER_TICK = 3;
const SHADOW_JUDGE_TIMEOUT_MS = 15_000;

export const GROUP_RECEPTION_SHADOW_SIGNATURE =
  'aliceMessage:string "Alice outbound group message with database id and Telegram message id", followUpMessages:string "Messages after Alice spoke, with database ids and reply markers", observation:string "Structured counts from the deterministic observer", rules:string "Outcome definitions and precedence" -> outcome:string "warm_reply, cold_ignored, hostile, or unknown_timeout", confidence:number "0..1 confidence", rationale:string "Short reason based only on the follow-up messages"';

export const GROUP_RECEPTION_SHADOW_RULES = [
  "Classify only the group's reaction to Alice's message.",
  "hostile: follow-up rejects, attacks, corrects Alice's behavior or language choice, tells Alice to stop, or expresses contempt toward Alice.",
  "warm_reply: follow-up substantively accepts, answers, builds on, thanks, or agrees with Alice, even without a Telegram reply marker.",
  `cold_ignored: at least ${COLD_THRESHOLD_MSGS} follow-up messages continue around Alice without hostile or warm response.`,
  "unknown_timeout: timeout or too little evidence; fewer than the cold threshold and no hostile or warm response.",
  "Precedence: hostile > warm_reply > cold_ignored > unknown_timeout.",
].join("\n");

interface AxForwardProgram<TPrediction> {
  forward(ai: unknown, values: unknown): Promise<TPrediction>;
}

interface ReceptionShadowPrediction {
  outcome?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

const receptionShadowProgram = ax(
  GROUP_RECEPTION_SHADOW_SIGNATURE,
) as unknown as AxForwardProgram<ReceptionShadowPrediction>;

export const ReceptionShadowPredictionSchema = z.object({
  outcome: z.enum(["warm_reply", "cold_ignored", "hostile", "unknown_timeout"]),
  confidence: z.coerce.number().min(0).max(1),
  rationale: z.string().default(""),
});

type ParsedReceptionShadowPrediction = z.infer<typeof ReceptionShadowPredictionSchema>;

type ReceptionShadowRecord = {
  schemaVersion: 1;
  generatedAt: string;
  kind: "sample" | "mismatch";
  aliceMessageLogId: number;
  channelId: string;
  model: string;
  deterministicOutcome: ReceptionOutcome;
  shadowOutcome: ReceptionOutcome;
  confidence: number;
  rationale: string;
  afterMessageCount: number;
  replyToAliceCount: number;
  hostileMatchCount: number;
  sourceMessageLogIds: number[];
};

let _receptionShadowAI: unknown | null = null;
let _receptionShadowModel = "";

type AliceOutboundMessage = {
  id: number;
  tick: number;
  chatId: string;
  msgId: number | null;
  text: string | null;
  createdAt: Date;
};

type LaterGroupMessage = {
  id: number;
  text: string | null;
  replyToMsgId: number | null;
};

type ReceptionOutcome = "warm_reply" | "cold_ignored" | "hostile" | "unknown_timeout";

type ReceptionClassification =
  | {
      outcome: Exclude<ReceptionOutcome, "unknown_timeout">;
      signal: number;
      afterMessageCount: number;
      replyToAliceCount: number;
      hostileMatchCount: number;
      sourceMessageLogIds: number[];
    }
  | {
      outcome: "unknown_timeout";
      signal: null;
      afterMessageCount: number;
      replyToAliceCount: number;
      hostileMatchCount: number;
      sourceMessageLogIds: number[];
    }
  | null;

export function updateGroupReception(ctx: { graph: WorldModel; nowMs: number }): void {
  const db = getDb();
  const nowMs = ctx.nowMs;
  // Drizzle mode:"timestamp" 自动处理 Date ↔ epoch 秒转换，无需手动
  const scanCutoff = new Date(nowMs - RECEPTION_SCAN_MS);

  // 查 Alice 最近的群聊发言候选。逐行读取，避免 MAX(created_at) 和 msgId 错行。
  let aliceGroupMsgs: AliceOutboundMessage[];
  let shadowJudgeScheduled = 0;
  try {
    aliceGroupMsgs = db
      .select({
        id: messageLog.id,
        tick: messageLog.tick,
        chatId: messageLog.chatId,
        msgId: messageLog.msgId,
        text: messageLog.text,
        createdAt: messageLog.createdAt,
      })
      .from(messageLog)
      .where(and(eq(messageLog.isOutgoing, true), gte(messageLog.createdAt, scanCutoff)))
      .orderBy(asc(messageLog.createdAt), asc(messageLog.id))
      .limit(MAX_ALICE_CANDIDATES)
      .all();
  } catch {
    return;
  }

  for (const aliceMsg of aliceGroupMsgs) {
    const channelId = aliceMsg.chatId;
    if (!isGroupChannel(ctx.graph, channelId)) continue;

    let alreadyEvaluated: Array<{ id: number }>;
    try {
      alreadyEvaluated = db
        .select({ id: interventionOutcomeEvidence.id })
        .from(interventionOutcomeEvidence)
        .where(eq(interventionOutcomeEvidence.aliceMessageLogId, aliceMsg.id))
        .limit(1)
        .all();
    } catch {
      continue;
    }
    if (alreadyEvaluated.length > 0) continue;

    // 查 Alice 发言之后在该群的消息（Drizzle ORM）
    let afterMsgs: LaterGroupMessage[];
    try {
      afterMsgs = db
        .select({
          id: messageLog.id,
          text: messageLog.text,
          replyToMsgId: messageLog.replyToMsgId,
        })
        .from(messageLog)
        .where(
          and(
            eq(messageLog.chatId, channelId),
            eq(messageLog.isOutgoing, false),
            or(
              gt(messageLog.createdAt, aliceMsg.createdAt),
              and(eq(messageLog.createdAt, aliceMsg.createdAt), gt(messageLog.id, aliceMsg.id)),
            ),
          ),
        )
        .orderBy(asc(messageLog.createdAt), asc(messageLog.id))
        .limit(MAX_AFTER_MESSAGES)
        .all();
    } catch {
      continue;
    }

    const classification = classifyReception(aliceMsg, afterMsgs, nowMs);
    if (!classification) continue;

    const previousReception =
      classification.signal === null ? null : readSocialReception(ctx.graph, channelId);
    const nextReception =
      classification.signal === null
        ? null
        : nextSocialReception(ctx.graph, channelId, classification.signal, nowMs);

    let inserted: Array<{ id: number }>;
    try {
      inserted = db
        .insert(interventionOutcomeEvidence)
        .values({
          tick: aliceMsg.tick,
          channelId,
          aliceMessageLogId: aliceMsg.id,
          aliceMsgId: aliceMsg.msgId,
          aliceMessageAtMs: aliceMsg.createdAt.getTime(),
          evaluatedAtMs: nowMs,
          outcome: classification.outcome,
          signal: classification.signal,
          afterMessageCount: classification.afterMessageCount,
          replyToAliceCount: classification.replyToAliceCount,
          hostileMatchCount: classification.hostileMatchCount,
          sourceMessageLogIdsJson: JSON.stringify(classification.sourceMessageLogIds),
          previousReception,
          nextReception,
        })
        .onConflictDoNothing()
        .returning({ id: interventionOutcomeEvidence.id })
        .all();
    } catch {
      continue;
    }
    const insertedEvidence = inserted[0];
    if (insertedEvidence) {
      recordEmotionFromReception(ctx.graph, {
        channelId,
        classification,
        evidenceId: insertedEvidence.id,
        nowMs,
      });
    }

    if (insertedEvidence && shadowJudgeScheduled < MAX_SHADOW_JUDGE_PER_TICK) {
      void evaluateReceptionShadowJudge(aliceMsg, afterMsgs, classification, nowMs).catch(
        (error) => {
          log.debug("Group reception Ax shadow judge failed", {
            aliceMessageLogId: aliceMsg.id,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      shadowJudgeScheduled += 1;
    }

    if (inserted.length === 0 || classification.signal === null || nextReception === null) {
      continue;
    }

    ctx.graph.setDynamic(channelId, "social_reception", nextReception);
    ctx.graph.setDynamic(channelId, "social_reception_ms", nowMs);
    log.info("Social reception updated", {
      channel: channelId,
      outcome: classification.outcome,
      old: previousReception?.toFixed(2) ?? "0.00",
      new: nextReception.toFixed(2),
    });
  }
}

/**
 * 初始化群聊 reception Ax shadow judge。
 *
 * 这个 judge 只记录旁路诊断，不写 evidence、不改 social_reception。
 * @see docs/adr/263-ax-llm-program-optimization/README.md
 */
export function initGroupReceptionShadowJudge(config: Config): void {
  if (!config.llmReflectApiKey) {
    log.debug("Reflect Provider API key 为空，group reception shadow judge 将被跳过");
    return;
  }
  _receptionShadowAI = AxAI.create({
    name: "openai",
    apiKey: config.llmReflectApiKey,
    apiURL: config.llmReflectBaseUrl,
    config: { model: config.llmReflectModel as never, stream: false, temperature: 0 },
  } as never);
  _receptionShadowModel = config.llmReflectModel;
  log.info("Group reception Ax shadow judge 初始化完成", { model: _receptionShadowModel });
}

/** 测试用重置。 */
export function resetGroupReceptionShadowJudge(): void {
  _receptionShadowAI = null;
  _receptionShadowModel = "";
}

export function isGroupReceptionShadowJudgeInitialized(): boolean {
  return _receptionShadowAI !== null && _receptionShadowModel !== "";
}

function isGroupChannel(graph: WorldModel, channelId: string): boolean {
  if (!graph.has(channelId)) return false;
  if (graph.getNodeType(channelId) !== "channel") return false;

  const chatType = graph.getChannel(channelId).chat_type;
  if (chatType !== "group" && chatType !== "supergroup") return false;

  return channelId.startsWith("channel:-");
}

function classifyReception(
  aliceMsg: AliceOutboundMessage,
  afterMsgs: LaterGroupMessage[],
  nowMs: number,
): ReceptionClassification {
  const sourceMessageLogIds = afterMsgs.map((m) => m.id);
  const replyToAliceCount =
    aliceMsg.msgId === null ? 0 : afterMsgs.filter((m) => m.replyToMsgId === aliceMsg.msgId).length;
  const hostileMatchCount = afterMsgs.filter((m) => containsHostileKeyword(m.text)).length;
  const common = {
    afterMessageCount: afterMsgs.length,
    replyToAliceCount,
    hostileMatchCount,
    sourceMessageLogIds,
  };

  if (hostileMatchCount > 0) {
    return { ...common, outcome: "hostile", signal: -0.5 };
  }
  if (replyToAliceCount > 0) {
    return { ...common, outcome: "warm_reply", signal: 0.3 };
  }
  if (afterMsgs.length >= COLD_THRESHOLD_MSGS) {
    return { ...common, outcome: "cold_ignored", signal: -0.2 };
  }
  if (nowMs - aliceMsg.createdAt.getTime() >= RECEPTION_LOOKBACK_MS) {
    return { ...common, outcome: "unknown_timeout", signal: null };
  }

  return null;
}

function recordEmotionFromReception(
  graph: WorldModel,
  input: {
    channelId: string;
    classification: NonNullable<ReceptionClassification>;
    evidenceId: number;
    nowMs: number;
  },
): void {
  if (input.classification.outcome === "warm_reply") {
    appraiseWarmReturnRepair(graph, { channelId: input.channelId, nowMs: input.nowMs });
    return;
  }

  if (input.classification.outcome !== "hostile") return;

  const directPushback = input.classification.replyToAliceCount > 0 ? 0.1 : 0;
  const repeatedPushback = Math.min(
    0.15,
    Math.max(0, input.classification.hostileMatchCount - 1) * 0.05,
  );
  const intensity = 0.45 + directPushback + repeatedPushback;

  recordEmotionEpisode(graph, {
    kind: "hurt",
    targetId: input.channelId,
    nowMs: input.nowMs,
    intensity,
    confidence: 0.75,
    cause: {
      type: "feedback",
      evidenceId: String(input.evidenceId),
      summary:
        input.classification.replyToAliceCount > 0
          ? "A direct group response pushed back sharply after you spoke."
          : "The group pushed back sharply after you spoke.",
    },
  });
}

function containsHostileKeyword(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return HOSTILE_KEYWORDS.some((kw) => normalized.includes(kw));
}

async function evaluateReceptionShadowJudge(
  aliceMsg: AliceOutboundMessage,
  afterMsgs: LaterGroupMessage[],
  classification: NonNullable<ReceptionClassification>,
  nowMs: number,
): Promise<void> {
  if (!_receptionShadowAI || !_receptionShadowModel) return;

  const prediction = await withTimeout(
    receptionShadowProgram.forward(_receptionShadowAI, {
      aliceMessage: formatAliceMessageForShadow(aliceMsg),
      followUpMessages: formatAfterMessagesForShadow(aliceMsg, afterMsgs),
      observation: [
        `afterMessageCount=${classification.afterMessageCount}`,
        `replyToAliceCount=${classification.replyToAliceCount}`,
        `hostileMatchCount=${classification.hostileMatchCount}`,
        `elapsedMs=${Math.max(0, nowMs - aliceMsg.createdAt.getTime())}`,
      ].join("\n"),
      rules: GROUP_RECEPTION_SHADOW_RULES,
    }),
    SHADOW_JUDGE_TIMEOUT_MS,
  );
  const parsed = parseReceptionShadowPrediction(prediction);
  if (!parsed) return;

  const payload = {
    aliceMessageLogId: aliceMsg.id,
    model: _receptionShadowModel,
    deterministicOutcome: classification.outcome,
    shadowOutcome: parsed.outcome,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
  };
  const kind =
    parsed.outcome !== classification.outcome && parsed.confidence >= 0.6 ? "mismatch" : "sample";
  writeReceptionShadowRecord({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind,
    aliceMessageLogId: aliceMsg.id,
    channelId: aliceMsg.chatId,
    model: _receptionShadowModel,
    deterministicOutcome: classification.outcome,
    shadowOutcome: parsed.outcome,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    afterMessageCount: classification.afterMessageCount,
    replyToAliceCount: classification.replyToAliceCount,
    hostileMatchCount: classification.hostileMatchCount,
    sourceMessageLogIds: classification.sourceMessageLogIds,
  });

  if (kind === "mismatch") {
    log.info("Group reception Ax shadow judge mismatch", payload);
    return;
  }
  log.debug("Group reception Ax shadow judge sampled", payload);
}

function writeReceptionShadowRecord(record: ReceptionShadowRecord): void {
  try {
    ensureParentDir(ALICE_GROUP_RECEPTION_SHADOW_LOG_PATH);
    appendFileSync(ALICE_GROUP_RECEPTION_SHADOW_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    log.debug("Group reception Ax shadow record write failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseReceptionShadowPrediction(
  prediction: ReceptionShadowPrediction,
): ParsedReceptionShadowPrediction | null {
  const normalized = {
    ...prediction,
    outcome:
      typeof prediction.outcome === "string"
        ? prediction.outcome.trim().toLowerCase()
        : prediction.outcome,
  };
  const parsed = ReceptionShadowPredictionSchema.safeParse(normalized);
  if (!parsed.success) {
    log.debug("Group reception Ax shadow judge schema failed", {
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
}

function formatAliceMessageForShadow(aliceMsg: AliceOutboundMessage): string {
  return [
    `db_id=${aliceMsg.id}`,
    `telegram_msg_id=${aliceMsg.msgId ?? "unknown"}`,
    `created_at_ms=${aliceMsg.createdAt.getTime()}`,
    `text=${aliceMsg.text ?? ""}`,
  ].join("\n");
}

function formatAfterMessagesForShadow(
  aliceMsg: AliceOutboundMessage,
  afterMsgs: LaterGroupMessage[],
): string {
  if (afterMsgs.length === 0) return "(no follow-up messages)";
  return afterMsgs
    .map((msg) => {
      const replyMarker =
        aliceMsg.msgId !== null && msg.replyToMsgId === aliceMsg.msgId
          ? "reply_to_alice"
          : "not_reply";
      return `db_id=${msg.id} ${replyMarker}: ${msg.text ?? ""}`;
    })
    .join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nextSocialReception(
  graph: WorldModel,
  channelId: string,
  signal: number,
  nowMs: number,
): number {
  const old = readSocialReception(graph, channelId);
  const updated = (1 - RECEPTION_ALPHA) * old + RECEPTION_ALPHA * signal;
  const lastUpdateMs = readSocialReceptionMs(graph, channelId) || nowMs;
  const hoursSinceUpdate = (nowMs - lastUpdateMs) / 3600_000;
  const decayed = updated * RECEPTION_HOURLY_DECAY ** hoursSinceUpdate;
  return Math.max(-1, Math.min(1, decayed));
}
