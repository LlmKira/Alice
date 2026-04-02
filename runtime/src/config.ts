/**
 * 全局配置：环境变量 + 压力场模型参数默认值。
 */
import { z } from "zod";
import {
  type AttentionDebtConfig,
  DEFAULT_ATTENTION_DEBT_CONFIG,
} from "./pressure/attention-debt.js";
import {
  DEFAULT_SATURATION_COST_CONFIG,
  DEFAULT_SOCIAL_COST_CONFIG,
  type SaturationCostConfig,
  SaturationCostConfigSchema,
  type SocialCostConfig,
  SocialCostConfigSchema,
} from "./pressure/social-cost.js";
import type { PersonalityWeights, PressureDims } from "./utils/math.js";

// -- D5: Provider Fallback（ADR-123 §D5）-------------------------------------
// @see docs/adr/123-crystallization-substrate-generalization.md §D5

export const ProviderConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  modalities: z.array(z.enum(["vision", "tts", "embedding"])).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * 从 env 合成 provider fallback 链。
 *
 * 主力：LLM_BASE_URL + LLM_API_KEY + LLM_MODEL
 * 备用：LLM_FALLBACK_BASE_URL + LLM_FALLBACK_API_KEY + LLM_FALLBACK_MODEL
 * 高级：PROVIDERS JSON 数组（覆盖以上所有）
 */
function parseProviders(): ProviderConfig[] {
  // 主力 + 可选备用（纯 .env 扁平变量，不再支持 PROVIDERS JSON blob）
  const providers: ProviderConfig[] = [
    {
      name: "primary",
      baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.LLM_API_KEY ?? "",
      model: process.env.LLM_MODEL ?? "gpt-4o",
    },
  ];

  // 备用 provider：主力熔断后自动切换
  if (process.env.LLM_FALLBACK_BASE_URL && process.env.LLM_FALLBACK_API_KEY) {
    providers.push({
      name: "fallback",
      baseUrl: process.env.LLM_FALLBACK_BASE_URL,
      apiKey: process.env.LLM_FALLBACK_API_KEY,
      model: process.env.LLM_FALLBACK_MODEL ?? "gpt-4o",
    });
  }

  return providers;
}

export interface Config {
  // Telegram
  telegramApiId: number;
  telegramApiHash: string;
  telegramPhone: string;

  // LLM
  /** D5: 多 provider fallback 链（ADR-123 §D5）。 */
  providers: ProviderConfig[];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Reflection 专用模型（空则回退到 llmModel）。内省不面向用户，可用更便宜的模型。 */
  llmReflectModel: string;
  /** ADR-226: Reflect Provider base URL（空则回退到 llmBaseUrl）。 */
  llmReflectBaseUrl: string;
  /** ADR-226: Reflect Provider API key（空则回退到 llmApiKey）。 */
  llmReflectApiKey: string;

  // ADR-226: 话题自动聚类
  clustering: {
    /** 总开关。 */
    enabled: boolean;
    /** 每 channel 缓冲消息数量阈值（达到即 flush）。 */
    bufferSize: number;
    /** 缓冲最大年龄（ms），超时且 >= minMessages 时 flush。 */
    maxAgeMs: number;
    /** 超时 flush 的最小消息数。 */
    minMessages: number;
    /** 每 channel 同时存在的 auto-thread 上限。 */
    maxAutoThreadsPerChannel: number;
  };

  // ADR-88: Vision（图片感知）
  /** Vision 模型名称（如 gpt-4o-mini）。空字符串 = 禁用图片感知。 */
  visionModel: string;
  /** Vision API base URL（空则回退到 llmBaseUrl）。 */
  visionBaseUrl: string;
  /** Vision API key（空则回退到 llmApiKey）。 */
  visionApiKey: string;
  /** 每 tick 最多处理的图片数量。 */
  visionMaxPerTick: number;

  // ADR-88: TTS（语音合成）
  /** TTS API base URL（OpenAI-compatible /audio/speech 或 Fish Audio）。空 = 禁用。 */
  ttsBaseUrl: string;
  /** TTS API key。 */
  ttsApiKey: string;
  /** TTS 模型名称（如 tts-1, speech-1.5）。 */
  ttsModel: string;
  /** TTS 语音 ID（voice preset 或 Fish Audio reference_id）。 */
  ttsVoice: string;
  /** MiniMax Group ID（MiniMax TTS 专用，其他后端忽略）。 */
  ttsGroupId: string;

  // ADR-119: ASR（语音识别）
  /** ASR API base URL（OpenAI /audio/transcriptions 兼容）。空 = 禁用。 */
  asrBaseUrl: string;
  /** ASR API key。 */
  asrApiKey: string;
  /** ASR 模型名称（如 whisper-1）。 */
  asrModel: string;

  /** ADR-117 D7: Exa API key（外部知识搜索）。空字符串 = 禁用 browse。 */
  exaApiKey: string;
  /** ADR-132 Wave 3: 音乐 API base URL（NeteaseCloudMusicApi 兼容端点）。空 = 禁用。 */
  musicApiBaseUrl: string;
  /** ADR-132 Wave 4: YouTube Data API v3 key。空 = 仅 Bilibili 可用。 */
  youtubeApiKey: string;
  /** WD14 Tagger 服务 URL。默认 http://127.0.0.1:39100，不可用时自动降级。 */
  wdTaggerUrl: string;
  /** ADR-153: AnimeIDF 分类服务 URL。默认 http://127.0.0.1:39101，不可用时降级（全部通过）。 */
  animeClassifyUrl: string;

  // OCR — 本地 PaddleOCR PP-OCRv4（无 API 费用）
  /** OCR 启用开关。默认启用。 */
  ocrEnabled: boolean;
  /** 每 tick 最多处理的 OCR 图片数量（独立于 visionMaxPerTick）。 */
  ocrMaxPerTick: number;
  /** OCR 置信度阈值（0-1），低于此分数的文本块丢弃。 */
  ocrMinConfidence: number;

  // 压力场参数
  /** ADR-64 VI-1: P4 线程年龄对数尺度（秒，默认 86400 = 1 天）。 */
  threadAgeScale: number;
  delta: number; // P4 deadline 奇异性指数
  // ADR-111: betaR 已迁移为 P3_BETA_R 常量（从 Weber-Fechner 推导，不可配置）
  eta: number; // P6 好奇心基线
  k: number; // P6 回望窗口
  mu: number; // Laplacian 传播衰减
  d: number; // P2 遗忘曲线指数 (< 0)

  // API 归一化 κ（每压力分量）
  kappa: PressureDims;

  // ADR-23: P_prospect 参数
  kSteepness: number; // P_prospect sigmoid 陡度
  kappaProspect: number; // P_prospect 归一化 κ

  /** ADR-112 D4: 自适应 κ EMA 衰减系数（默认 0.02，50-tick 半衰期）。 */
  kappaAdaptAlpha: number;

  // 行动频率门
  actionRateWindow: number;
  /** chat-type-aware 行动频率硬上限（窗口内绝对计数）。@see ADR-113 F15, ADR-189 D2, ADR-206 §3 */
  rateCap: { private: number; group: number; channel: number; bot: number };
  actionRateFloor: number;

  // 人格演化
  learningRate: number;
  meanReversion: number;
  piMin: number;
  piHome: PersonalityWeights;

  // 时间 — 自适应 tick（论文 §6.4 Definition 6.3）
  /** Δt_min（毫秒）。 */
  dtMin: number;
  /** Δt_max（毫秒）。 */
  dtMax: number;
  /** κ_t — API → 间隔指数衰减常数。 */
  kappaT: number;
  snapshotIntervalS: number; // 快照间隔（秒）
  stalenessThreshold: number;

  // ADR-190: Wakeup Mode
  /** 触发 wakeup 模态的离线时长（秒）。低于此阈值的重启直接进 patrol。 */
  wakeupOfflineThresholdS: number;
  /** wakeup 毕业所需 tick 数。α_w(n) = min(1, n / N)。 */
  wakeupGraduationTicks: number;

  // Agent Mode FSM 阈值（论文 §6.2）
  /** conversation → patrol: focus 沉默超过此秒数。 */
  thetaSilenceS: number;
  /** patrol → consolidation: API 低于此值。 */
  thetaLowAPI: number;
  /** patrol → consolidation: P2 高于此值（记忆整理需求）。 */
  thetaMem: number;

  // ADR-225: Dormant Mode — 睡眠节律
  /** quiet window 开始的本地小时（默认 23）。跨午夜时 start > end（如 23-7）。 */
  quietWindowStart: number;
  /** quiet window 结束的本地小时（默认 7）。 */
  quietWindowEnd: number;
  /** patrol/consolidation → dormant: API 低于此值才入睡（默认 0.15）。 */
  thetaDormantAPI: number;
  /** dormant 期间亲密联系人唤醒阈值（tier < 此值的 directed 消息可唤醒，默认 150）。 */
  dormantWakeTier: number;

  // 空闲自启动
  idleThreshold: number; // 连续无行动秒数 → 触发行动

  // S10 群聊参与概率泄漏
  s10LeakProb: number;

  // ADR-110: self mood 衰减半衰期（秒）
  moodHalfLife: number;

  // 时区：用户本地时间与 UTC 的偏移（小时），如 UTC+8 → 8
  timezoneOffset: number;

  // 探索保护（ExplorationGuard）
  exploration: {
    maxJoinsPerDay: number;
    maxSearchPerHour: number;
    joinCooldownMs: number;
    searchCooldownMs: number;
    postJoinSearchCooldownMs: number;
    silentDurationS: number;
    apprenticeDurationS: number;
    apprenticeMaxMessages: number;
    circuitBreakerThreshold: number;
    circuitBreakerOpenMs: number;
  };

  // D5: Social Cost
  socialCost: SocialCostConfig;

  /** ADR-136: 饱和成本 C_sat 配置。@see docs/adr/136-constrained-vmax/README.md */
  saturationCost: SaturationCostConfig;

  /** Social POMDP: 不确定性惩罚系数 β。β=0 退化到无信念版本。 */
  beliefBeta: number;

  /** ADR-151: VoI 信息增益系数 γ。γ > 0 时高不确定性目标获得探索奖励，对冲 β·H 惩罚。 */
  beliefGamma: number;

  /** ADR-151 #6: Thompson Sampling 噪声系数 η。η > 0 时高 σ² 目标获得随机探索扰动。η=0 禁用。 */
  thompsonEta: number;

  /** ADR-180: IAUS 确定性模式（argmax 替代 Boltzmann）。仅测试用。 */
  iausDeterministic: boolean;

  /** ADR-222: Habituation α 系数（默认 0.5）。ρ_H = 1/(1+α·H)。 */
  habituationAlpha: number;
  /** ADR-222: Habituation 半衰期（秒，默认 1800）。 */
  habituationHalfLifeS: number;
  /** ADR-182 D1: Momentum bonus 系数。ADR-222: 从 0.2 降至 0.05。 */
  momentumBonus: number;
  /** ADR-182 D1: Momentum 衰减超时（ms）。 */
  momentumDecayMs: number;
  /** ADR-183: 人格驱动曲线调制强度（0 = 无调制，1 = 最大调制）。 */
  curveModulationStrength: number;
  /** ADR-185 §1: Desire boost 系数（0 = 禁用，默认 0.15）。 */
  desireBoost: number;
  /** ADR-185 §3: Mood nudge 幅度（0 = 禁用，默认 0.05）。 */
  moodNudgeScale: number;

  /** ADR-100: 注意力负债配置。 @see docs/adr/100-attention-debt.md §9 */
  attentionDebt: AttentionDebtConfig;

  /** ADR-114 D1: Budget zone 比例覆盖。@see docs/adr/114-context-assembly-rehabilitation.md */
  budgetZones?: Partial<Record<"anchor" | "situation" | "conversation" | "memory", number>>;

  /** ADR-121: 社交余光参数。@see docs/adr/121-social-peripheral-vision/README.md §3.4 */
  peripheral: {
    /** 每个共享频道最多注入的消息条数。 */
    perChannelCap: number;
    /** 总共最多注入的消息条数。 */
    totalCap: number;
    /** 最短文本长度（低于此长度的消息被过滤）。 */
    minTextLength: number;
  };

  /**
   * ADR-115: 内源性线程生成器参数。
   * @see docs/adr/115-evolve-observability/
   */
  generators: {
    /** 晨间 Digest 触发的本地小时（0-23）。 */
    digestHour: number;
    /** 周度反思触发的星期几（0=Sunday, 6=Saturday）。 */
    reflectionDay: number;
    /** 周度反思触发的本地小时（0-23）。 */
    reflectionHour: number;
    /** Anomaly Generator z-score 阈值。 */
    anomalyZThreshold: number;
  };

  /**
   * ADR-172: Operator 的私聊 channel ID（graph ID 格式 "channel:xxx"）。
   * 系统线程（morning_digest, weekly_reflection）路由到此频道。
   * 未设置时回退到 telegramAdmin 推导。
   */
  operatorChannelId: string;

  // 管理员
  telegramAdmin: string;

  // 日志
  logLevel: string;
}

export function loadConfig(): Config {
  return {
    telegramApiId: Number(process.env.TELEGRAM_API_ID ?? "0"),
    telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
    telegramPhone: process.env.TELEGRAM_PHONE ?? "",

    providers: parseProviders(),
    llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "gpt-4o",
    llmReflectModel: process.env.LLM_REFLECT_MODEL ?? process.env.LLM_MODEL ?? "gpt-4o",
    llmReflectBaseUrl:
      process.env.LLM_REFLECT_BASE_URL ?? process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    llmReflectApiKey: process.env.LLM_REFLECT_API_KEY ?? process.env.LLM_API_KEY ?? "",

    // ADR-226: 话题自动聚类
    clustering: {
      enabled: process.env.CLUSTERING_ENABLED !== "false",
      bufferSize: Number(process.env.CLUSTERING_BUFFER_SIZE ?? "30"),
      maxAgeMs: Number(process.env.CLUSTERING_MAX_AGE_MS ?? "300000"),
      minMessages: Number(process.env.CLUSTERING_MIN_MESSAGES ?? "5"),
      maxAutoThreadsPerChannel: Number(process.env.CLUSTERING_MAX_AUTO_THREADS ?? "3"),
    },

    // ADR-88: Vision — 空 VISION_MODEL = 禁用图片感知
    visionModel: process.env.VISION_MODEL ?? "",
    visionBaseUrl:
      process.env.VISION_BASE_URL ?? process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    visionApiKey: process.env.VISION_API_KEY ?? process.env.LLM_API_KEY ?? "",
    visionMaxPerTick: Number(process.env.VISION_MAX_PER_TICK ?? "5"),

    // ADR-88: TTS — 空 TTS_BASE_URL = 禁用语音
    ttsBaseUrl: process.env.TTS_BASE_URL ?? "",
    ttsApiKey: process.env.TTS_API_KEY ?? "",
    ttsModel: process.env.TTS_MODEL ?? "tts-1",
    ttsVoice: process.env.TTS_VOICE ?? "",
    ttsGroupId: process.env.TTS_GROUP_ID ?? "",

    // ADR-119: ASR — 空 ASR_BASE_URL = 禁用语音识别
    asrBaseUrl: process.env.ASR_BASE_URL ?? "",
    asrApiKey: process.env.ASR_API_KEY ?? "",
    asrModel: process.env.ASR_MODEL ?? "whisper-1",

    exaApiKey: process.env.EXA_API_KEY ?? "",
    musicApiBaseUrl: process.env.MUSIC_API_BASE_URL ?? "",
    youtubeApiKey: process.env.YOUTUBE_API_KEY ?? "",
    wdTaggerUrl: process.env.WD_TAGGER_URL ?? "http://127.0.0.1:39100",
    animeClassifyUrl: process.env.ANIME_CLASSIFY_URL ?? "http://127.0.0.1:39101",

    // OCR — 默认启用，本地 PaddleOCR 无 API 费用
    ocrEnabled: process.env.OCR_ENABLED !== "false",
    ocrMaxPerTick: Number(process.env.OCR_MAX_PER_TICK ?? "3"),
    ocrMinConfidence: Number(process.env.OCR_MIN_CONFIDENCE ?? "0.6"),

    threadAgeScale: 86_400, // ADR-64 VI-1: log(1 + age/τ) 的 τ，86400 秒 = 1 天
    delta: 1.0,
    // ADR-111: betaR 已迁移为 P3_BETA_R 常量（不再作为运行时配置）
    eta: 0.6,
    k: 20,
    mu: 0.3,
    d: -0.5,

    kappa: [5.0, 8.0, 8.0, 5.0, 3.0, 0.5], // ADR-64 VI-1: κ₄ 200→5（P4 从百万级降到个位数）

    kSteepness: 5.0,
    kappaProspect: 3.0,
    kappaAdaptAlpha: 0.02,

    actionRateWindow: 3000, // ADR-110: 3000 秒（50 分钟）窗口
    // ADR-113 F15 + ADR-189 D2 + ADR-206: chat-type-aware 硬上限（窗口内绝对计数，四 scope 独立配额）
    rateCap: { private: 10, group: 8, channel: 3, bot: 3 },
    actionRateFloor: 0.05,

    // 人格漂移速率校准（#8.3）：α=0.001 导致天级漂移，真实人格变化是月-年级
    // 均值回归强度（#17.1）：γ 需足够强以防止 winner-takes-all 退化
    learningRate: 0.0001,
    meanReversion: 0.002,
    piMin: 0.05,
    piHome: [0.25, 0.25, 0.25, 0.25], // ADR-98 W3.1: 四声部等权，消除 Diligence 先天优势

    dtMin: Number(process.env.DT_MIN_MS ?? "1000"),
    dtMax: Number(process.env.DT_MAX_MS ?? "300000"),
    kappaT: Number(process.env.KAPPA_T ?? "1.0"),
    snapshotIntervalS: Number(process.env.SNAPSHOT_INTERVAL_S ?? "600"), // 10 分钟
    stalenessThreshold: 0.5, // 归一化 L2 距离阈值（P1-2: 各维度归一化到 [0,1] 后等权）

    idleThreshold: 1800, // 1800 秒（30 分钟）无行动 → 自启动（ADR-81: 使用已选声部）

    s10LeakProb: 0.15, // S10: Diligence mark_read → System 2 泄漏概率（群聊参与）
    moodHalfLife: 3600, // ADR-110: self mood 衰减半衰期 3600 秒（1 小时回归一半）

    // ADR-190: Wakeup Mode — < 10 分钟的重启直接进 patrol，10 tick × 3-10s = 30-100s 的"翻消息"时间
    wakeupOfflineThresholdS: Number(process.env.WAKEUP_OFFLINE_THRESHOLD_S ?? "600"),
    wakeupGraduationTicks: Number(process.env.WAKEUP_GRADUATION_TICKS ?? "10"),

    // Agent Mode FSM 阈值（论文 §6.2）
    thetaSilenceS: 300, // ADR-113 §D3: focus 沉默 5 分钟 → 退出 conversation（异步 IM 场景）
    thetaLowAPI: 0.05, // API < 0.05 → 可进入 consolidation
    thetaMem: 0.3, // P2 > 0.3 → consolidation 有意义

    // ADR-225: Dormant Mode
    quietWindowStart: Number(process.env.QUIET_WINDOW_START ?? "23"),
    quietWindowEnd: Number(process.env.QUIET_WINDOW_END ?? "7"),
    thetaDormantAPI: Number(process.env.THETA_DORMANT_API ?? "0.15"),
    dormantWakeTier: Number(process.env.DORMANT_WAKE_TIER ?? "150"),

    // ADR-34 F1: 用户时区偏移（默认 UTC+8 中国标准时间）
    timezoneOffset: Number(process.env.TIMEZONE_OFFSET ?? "8"),

    exploration: {
      maxJoinsPerDay: Number(process.env.EXPLORE_MAX_JOINS_PER_DAY ?? "5"),
      maxSearchPerHour: Number(process.env.EXPLORE_MAX_SEARCH_PER_HOUR ?? "10"),
      joinCooldownMs: Number(process.env.EXPLORE_JOIN_COOLDOWN_MS ?? "3600000"),
      searchCooldownMs: Number(process.env.EXPLORE_SEARCH_COOLDOWN_MS ?? "300000"),
      postJoinSearchCooldownMs: Number(
        process.env.EXPLORE_POST_JOIN_SEARCH_COOLDOWN_MS ?? "1800000",
      ),
      silentDurationS: Number(process.env.EXPLORE_SILENT_DURATION_S ?? "600"),
      apprenticeDurationS: Number(process.env.EXPLORE_APPRENTICE_DURATION_S ?? "1800"),
      apprenticeMaxMessages: Number(process.env.EXPLORE_APPRENTICE_MAX_MSGS ?? "3"),
      circuitBreakerThreshold: Number(process.env.EXPLORE_CB_THRESHOLD ?? "3"),
      circuitBreakerOpenMs: Number(process.env.EXPLORE_CB_OPEN_MS ?? "3600000"),
    },

    socialCost: SocialCostConfigSchema.parse(DEFAULT_SOCIAL_COST_CONFIG),

    saturationCost: SaturationCostConfigSchema.parse(DEFAULT_SATURATION_COST_CONFIG),

    beliefBeta: 0.1,
    beliefGamma: 0.15,
    thompsonEta: 0.1,
    iausDeterministic: false,
    habituationAlpha: 0.5,
    habituationHalfLifeS: 1800,
    momentumBonus: 0.05,
    momentumDecayMs: 300_000,
    curveModulationStrength: 0.5,
    desireBoost: Number(process.env.DESIRE_BOOST ?? "0.15"),
    moodNudgeScale: Number(process.env.MOOD_NUDGE_SCALE ?? "0.05"),

    attentionDebt: { ...DEFAULT_ATTENTION_DEBT_CONFIG },

    peripheral: {
      perChannelCap: Number(process.env.PERIPHERAL_PER_CHANNEL_CAP ?? "3"),
      totalCap: Number(process.env.PERIPHERAL_TOTAL_CAP ?? "8"),
      minTextLength: Number(process.env.PERIPHERAL_MIN_TEXT_LENGTH ?? "15"),
    },

    generators: {
      digestHour: 8,
      reflectionDay: 0, // Sunday
      reflectionHour: 20,
      anomalyZThreshold: 3.0,
    },

    // ADR-172: 系统线程路由目标。未设置时从 TELEGRAM_ADMIN 推导
    operatorChannelId:
      process.env.OPERATOR_CHANNEL_ID ??
      (process.env.TELEGRAM_ADMIN ? `channel:${process.env.TELEGRAM_ADMIN}` : ""),

    telegramAdmin: process.env.TELEGRAM_ADMIN ?? "",

    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
