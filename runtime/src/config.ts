/**
 * 全局配置：TOML 控制面 + env secrets。
 *
 * runtime/config.toml 保存可公开的结构化配置；密钥、手机号等敏感值只通过
 * TOML 中的 *_env 字段引用环境变量。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, type TomlTable } from "smol-toml";
import { z } from "zod";
import { ensureChannelId, telegramChannelId } from "./graph/constants.js";
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
import { ALICE_STATE_DIR } from "./runtime-paths.js";
import type { PersonalityWeights, PressureDims } from "./utils/math.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = resolve(__dirname, "..");
const DEFAULT_CONFIG_PATH = resolve(RUNTIME_ROOT, "config.toml");
const OptionalEnvNameSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const OptionalUrlStringSchema = z.union([z.literal(""), z.string().url()]);

// -- D5: Provider Fallback（ADR-123 §D5）-------------------------------------
// @see docs/adr/123-crystallization-substrate-generalization.md §D5

export const ProviderConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  modalities: z.array(z.enum(["vision", "tts", "embedding"])).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const LlmEndpointTomlSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  model: z.string().min(1),
  modalities: z.array(z.enum(["vision", "tts", "embedding"])).optional(),
});

const LlmRoutingTomlSchema = z.object({
  first_pass: z.array(z.string().min(1)).min(1),
  tool_tick: z.array(z.string().min(1)).min(1),
  eval: z.array(z.string().min(1)).min(1).optional(),
  auxiliary: z.array(z.string().min(1)).min(1).optional(),
  reflect: z.array(z.string().min(1)).min(1).optional(),
});

const RuntimeTomlSchema = z.object({
  telegram: z.object({
    api_id_env: z.string().min(1).default("TELEGRAM_API_ID"),
    api_hash_env: z.string().min(1).default("TELEGRAM_API_HASH"),
    phone_env: z.string().min(1).default("TELEGRAM_PHONE"),
    admin_env: z.string().min(1).default("TELEGRAM_ADMIN"),
    operator_channel_id: z.string().default(""),
  }),
  qq: z
    .object({
      onebot_api_base_url: OptionalUrlStringSchema.default(""),
      onebot_event_ws_url: OptionalUrlStringSchema.default(""),
      onebot_access_token_env: OptionalEnvNameSchema,
      onebot_timeout_ms: z.number().int().positive().default(10_000),
      onebot_reconnect_min_ms: z.number().int().positive().default(1_000),
      onebot_reconnect_max_ms: z.number().int().positive().default(60_000),
    })
    .default({}),
  llm: z
    .object({
      endpoints: z.array(LlmEndpointTomlSchema).min(1),
      routing: LlmRoutingTomlSchema,
    })
    .superRefine((llm, ctx) => {
      const names = new Set(llm.endpoints.map((endpoint) => endpoint.name));
      const checkRoute = (routeName: keyof z.infer<typeof LlmRoutingTomlSchema>) => {
        const route = llm.routing[routeName];
        if (!route) return;
        for (const endpointName of route) {
          if (!names.has(endpointName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["routing", routeName],
              message: `Unknown LLM endpoint "${endpointName}" in llm.routing.${routeName}`,
            });
          }
        }
      };
      checkRoute("first_pass");
      checkRoute("tool_tick");
      checkRoute("eval");
      checkRoute("auxiliary");
      checkRoute("reflect");
    }),
  vision: z
    .object({
      model: z.string().default(""),
      base_url: z.string().url().optional(),
      api_key_env: OptionalEnvNameSchema,
      max_per_tick: z.number().int().nonnegative().default(5),
    })
    .default({}),
  tts: z
    .object({
      base_url: z.string().default(""),
      api_key_env: OptionalEnvNameSchema,
      model: z.string().default("tts-1"),
      voice: z.string().default(""),
      group_id_env: OptionalEnvNameSchema,
    })
    .default({}),
  asr: z
    .object({
      base_url: z.string().default(""),
      api_key_env: OptionalEnvNameSchema,
      model: z.string().default("whisper-1"),
    })
    .default({}),
  services: z
    .object({
      exa_api_key_env: OptionalEnvNameSchema,
      music_api_base_url: z.string().default(""),
      youtube_api_key_env: OptionalEnvNameSchema,
      wd_tagger_url: z.string().default("http://127.0.0.1:39100"),
      anime_classify_url: z.string().default("http://127.0.0.1:39101"),
    })
    .default({}),
  ocr: z
    .object({
      enabled: z.boolean().default(true),
      max_per_tick: z.number().int().nonnegative().default(3),
      min_confidence: z.number().min(0).max(1).default(0.6),
    })
    .default({}),
  pressure: z
    .object({
      thread_age_scale: z.number().positive().default(86_400),
      delta: z.number().default(1.0),
      eta: z.number().default(0.6),
      k: z.number().default(20),
      mu: z.number().default(0.3),
      d: z.number().default(-0.5),
      kappa: z
        .tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
        .default([5.0, 8.0, 8.0, 5.0, 3.0, 0.5]),
      k_steepness: z.number().default(5.0),
      kappa_prospect: z.number().default(3.0),
      kappa_adapt_alpha: z.number().default(0.02),
    })
    .default({}),
  action_rate: z
    .object({
      window_s: z.number().int().positive().default(3000),
      floor: z.number().default(0.05),
      cap_private: z.number().int().nonnegative().default(10),
      cap_group: z.number().int().nonnegative().default(8),
      cap_channel: z.number().int().nonnegative().default(3),
      cap_bot: z.number().int().nonnegative().default(3),
    })
    .default({}),
  personality: z
    .object({
      learning_rate: z.number().default(0.0001),
      mean_reversion: z.number().default(0.002),
      pi_min: z.number().default(0.05),
      pi_home: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .default([0.25, 0.25, 0.25, 0.25]),
      mood_half_life_s: z.number().positive().default(3600),
      mood_nudge_scale: z.number().default(0.05),
    })
    .default({}),
  time: z
    .object({
      dt_min_ms: z.number().int().positive().default(1000),
      dt_max_ms: z.number().int().positive().default(300_000),
      kappa_t: z.number().default(1.0),
      snapshot_interval_s: z.number().int().positive().default(600),
      staleness_threshold: z.number().default(0.5),
      timezone_offset: z.number().default(8),
      rhythm_profile_rebuild_interval_s: z.number().int().nonnegative().default(21_600),
    })
    .default({}),
  wakeup: z
    .object({
      offline_threshold_s: z.number().int().nonnegative().default(600),
      graduation_ticks: z.number().int().nonnegative().default(10),
    })
    .default({}),
  mode: z
    .object({
      theta_silence_s: z.number().int().nonnegative().default(300),
      theta_low_api: z.number().default(0.05),
      theta_mem: z.number().default(0.3),
    })
    .default({}),
  dormant: z
    .object({
      quiet_window_start: z.number().int().min(0).max(23).default(23),
      quiet_window_end: z.number().int().min(0).max(23).default(7),
      theta_api: z.number().default(0.15),
      wake_tier: z.number().default(150),
    })
    .default({}),
  idle: z
    .object({
      threshold_s: z.number().int().nonnegative().default(1800),
      s10_leak_prob: z.number().default(0.15),
    })
    .default({}),
  exploration: z
    .object({
      max_joins_per_day: z.number().int().nonnegative().default(5),
      max_search_per_hour: z.number().int().nonnegative().default(10),
      join_cooldown_ms: z.number().int().nonnegative().default(3_600_000),
      search_cooldown_ms: z.number().int().nonnegative().default(300_000),
      post_join_search_cooldown_ms: z.number().int().nonnegative().default(1_800_000),
      silent_duration_s: z.number().int().nonnegative().default(600),
      apprentice_duration_s: z.number().int().nonnegative().default(1800),
      apprentice_max_messages: z.number().int().nonnegative().default(3),
      circuit_breaker_threshold: z.number().int().positive().default(3),
      circuit_breaker_open_ms: z.number().int().nonnegative().default(3_600_000),
    })
    .default({}),
  belief: z
    .object({
      beta: z.number().default(0.1),
      gamma: z.number().default(0.15),
      thompson_eta: z.number().default(0.1),
    })
    .default({}),
  iaus: z
    .object({
      deterministic: z.boolean().default(false),
      habituation_alpha: z.number().default(0.5),
      habituation_half_life_s: z.number().positive().default(1800),
      momentum_bonus: z.number().default(0.05),
      momentum_decay_ms: z.number().int().nonnegative().default(300_000),
      curve_modulation_strength: z.number().default(0.5),
      desire_boost: z.number().default(0.15),
    })
    .default({}),
  attention_debt: z
    .object({
      delta: z.number().default(DEFAULT_ATTENTION_DEBT_CONFIG.delta),
    })
    .default({}),
  budget_zones: z
    .object({
      anchor: z.number().optional(),
      situation: z.number().optional(),
      conversation: z.number().optional(),
      memory: z.number().optional(),
    })
    .optional(),
  peripheral: z
    .object({
      per_channel_cap: z.number().int().nonnegative().default(3),
      total_cap: z.number().int().nonnegative().default(8),
      min_text_length: z.number().int().nonnegative().default(15),
    })
    .default({}),
  generators: z
    .object({
      digest_hour: z.number().int().min(0).max(23).default(8),
      reflection_day: z.number().int().min(0).max(6).default(0),
      reflection_hour: z.number().int().min(0).max(23).default(20),
      anomaly_z_threshold: z.number().default(3.0),
    })
    .default({}),
  focus: z
    .object({
      whitelist_path: z.string().default(""),
      whitelist: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  log: z
    .object({
      level: z.string().default("info"),
    })
    .default({}),
});

type RuntimeTomlConfig = z.infer<typeof RuntimeTomlSchema>;

const DEFAULT_FOCUS_WHITELIST_FILENAME = "focus-whitelist.txt";

function parseFocusWhitelistFile(content: string): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.replace(/\s+#.*$/u, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const channelId = ensureChannelId(trimmed);
    if (channelId) {
      targets.add(channelId);
      continue;
    }
    targets.add(trimmed);
  }
  return targets;
}

function loadFocusWhitelistFromConfig(focus: RuntimeTomlConfig["focus"]): {
  path: string;
  targets: ReadonlySet<string> | null;
} {
  if (focus.whitelist.length > 0) {
    const normalized = new Set<string>();
    for (const target of focus.whitelist) {
      normalized.add(ensureChannelId(target) ?? target);
    }
    return { path: "config.toml:focus.whitelist", targets: normalized };
  }

  const rawPath = focus.whitelist_path.trim();
  if (rawPath) {
    const resolvedPath = resolve(rawPath);
    const content = readFileSync(resolvedPath, "utf-8");
    return {
      path: resolvedPath,
      targets: parseFocusWhitelistFile(content),
    };
  }

  const resolvedPath = resolve(ALICE_STATE_DIR, DEFAULT_FOCUS_WHITELIST_FILENAME);
  if (!existsSync(resolvedPath)) return { path: "", targets: null };

  const content = readFileSync(resolvedPath, "utf-8");
  return {
    path: resolvedPath,
    targets: parseFocusWhitelistFile(content),
  };
}

function loadRuntimeToml(): RuntimeTomlConfig {
  const configPath = resolve(process.env.ALICE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH);
  if (!existsSync(configPath)) {
    throw new Error(`Missing runtime config TOML: ${configPath}`);
  }

  const parsed = parseToml(readFileSync(configPath, "utf-8")) as TomlTable;
  return RuntimeTomlSchema.parse(parsed);
}

function secretFromEnv(envName: string | undefined, label: string, required = false): string {
  if (!envName) return "";
  const value = process.env[envName] ?? "";
  if (required && value.length === 0) {
    throw new Error(`Missing required secret env ${envName} for ${label}`);
  }
  return value;
}

function intSecretFromEnv(envName: string, label: string): number {
  const raw = secretFromEnv(envName, label);
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid integer env ${envName} for ${label}`);
  }
  return value;
}

function providersFromToml(config: RuntimeTomlConfig): ProviderConfig[] {
  return config.llm.endpoints.map((provider) =>
    ProviderConfigSchema.parse({
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: secretFromEnv(provider.api_key_env, `llm.endpoints "${provider.name}"`),
      model: provider.model,
      modalities: provider.modalities,
    }),
  );
}

function optionalBudgetZones(
  budgetZones: RuntimeTomlConfig["budget_zones"],
): Config["budgetZones"] {
  if (!budgetZones) return undefined;
  const result: NonNullable<Config["budgetZones"]> = {};
  for (const key of ["anchor", "situation", "conversation", "memory"] as const) {
    const value = budgetZones[key];
    if (value != null) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface Config {
  // Telegram
  telegramApiId: number;
  telegramApiHash: string;
  telegramPhone: string;

  // QQ OneBot bridge
  /** ADR-264/265: OneBot v11 HTTP action base URL. Empty = QQ transport disabled. */
  qqOneBotApiBaseUrl: string;
  /** ADR-264/265: OneBot v11 event WebSocket URL. Empty = QQ inbound disabled. */
  qqOneBotEventWsUrl: string;
  /** OneBot access token. Empty when the protocol endpoint does not require one. */
  qqOneBotAccessToken: string;
  /** OneBot action request timeout. */
  qqOneBotTimeoutMs: number;
  /** OneBot event WebSocket reconnect lower bound. */
  qqOneBotReconnectMinMs: number;
  /** OneBot event WebSocket reconnect upper bound. */
  qqOneBotReconnectMaxMs: number;

  // LLM
  /** D5: 多 LLM endpoint fallback 链（ADR-123 §D5）。 */
  providers: ProviderConfig[];
  /** 不同用途的 endpoint 路由。firstPass/toolTick 是 shuffle 池；eval/auxiliary/reflect 是 fallback 顺序。 */
  llmRouting: {
    firstPass: string[];
    toolTick: string[];
    eval: string[];
    auxiliary: string[];
    reflect: string[];
  };
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Reflection 专用模型（空则回退到 llmModel）。内省不面向用户，可用更便宜的模型。 */
  llmReflectModel: string;
  /** ADR-226: Reflect Provider base URL（空则回退到 llmBaseUrl）。 */
  llmReflectBaseUrl: string;
  /** ADR-226: Reflect Provider API key（空则回退到 llmApiKey）。 */
  llmReflectApiKey: string;

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
  /** ADR-261: rhythm_profiles 自动重建间隔。0 = 禁用自动重建。 */
  rhythmProfileRebuildIntervalS: number;

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
   * 焦点白名单来源。推荐使用 config.toml 的 focus.whitelist；兼容文件路径时为绝对路径。
   */
  focusWhitelistPath: string;
  /**
   * 候选目标白名单。设置后，焦点集与 IAUS 只会在这些 target 中挑选目标。
   * 压力场本体仍按全量图照常计算。
   */
  focusWhitelist: ReadonlySet<string> | null;

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

export function getLlmProviderByRoute(
  config: Pick<Config, "providers" | "llmRouting">,
  route: keyof Config["llmRouting"] = "firstPass",
): ProviderConfig | undefined {
  const providerByName = new Map(config.providers.map((provider) => [provider.name, provider]));
  for (const name of config.llmRouting[route] ?? []) {
    const provider = providerByName.get(name);
    if (provider) return provider;
  }
  return config.providers[0];
}

export function loadConfig(): Config {
  const toml = loadRuntimeToml();
  const providers = providersFromToml(toml);
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  const primaryProvider = providerByName.get(toml.llm.routing.first_pass[0]) ?? providers[0];
  const auxiliaryRoute = toml.llm.routing.auxiliary ?? toml.llm.routing.first_pass;
  const reflectProvider =
    providerByName.get(toml.llm.routing.reflect?.[0] ?? auxiliaryRoute[0]) ?? primaryProvider;
  const telegramAdmin = secretFromEnv(toml.telegram.admin_env, "telegram.admin_env");
  const focusWhitelist = loadFocusWhitelistFromConfig(toml.focus);

  return {
    telegramApiId: intSecretFromEnv(toml.telegram.api_id_env, "telegram.api_id_env"),
    telegramApiHash: secretFromEnv(toml.telegram.api_hash_env, "telegram.api_hash_env"),
    telegramPhone: secretFromEnv(toml.telegram.phone_env, "telegram.phone_env"),
    qqOneBotApiBaseUrl: toml.qq.onebot_api_base_url,
    qqOneBotEventWsUrl: toml.qq.onebot_event_ws_url,
    qqOneBotAccessToken: secretFromEnv(
      toml.qq.onebot_access_token_env,
      "qq.onebot_access_token_env",
    ),
    qqOneBotTimeoutMs: toml.qq.onebot_timeout_ms,
    qqOneBotReconnectMinMs: toml.qq.onebot_reconnect_min_ms,
    qqOneBotReconnectMaxMs: toml.qq.onebot_reconnect_max_ms,

    providers,
    llmRouting: {
      firstPass: toml.llm.routing.first_pass,
      toolTick: toml.llm.routing.tool_tick,
      eval: toml.llm.routing.eval ?? toml.llm.routing.first_pass,
      auxiliary: auxiliaryRoute,
      reflect: toml.llm.routing.reflect ?? auxiliaryRoute,
    },
    llmBaseUrl: primaryProvider.baseUrl,
    llmApiKey: primaryProvider.apiKey,
    llmModel: primaryProvider.model,
    llmReflectModel: reflectProvider.model,
    llmReflectBaseUrl: reflectProvider.baseUrl,
    llmReflectApiKey: reflectProvider.apiKey,

    visionModel: toml.vision.model,
    visionBaseUrl: toml.vision.base_url ?? primaryProvider.baseUrl,
    visionApiKey:
      secretFromEnv(toml.vision.api_key_env, "vision.api_key_env") || primaryProvider.apiKey,
    visionMaxPerTick: toml.vision.max_per_tick,

    ttsBaseUrl: toml.tts.base_url,
    ttsApiKey: secretFromEnv(toml.tts.api_key_env, "tts.api_key_env"),
    ttsModel: toml.tts.model,
    ttsVoice: toml.tts.voice,
    ttsGroupId: secretFromEnv(toml.tts.group_id_env, "tts.group_id_env"),

    asrBaseUrl: toml.asr.base_url,
    asrApiKey: secretFromEnv(toml.asr.api_key_env, "asr.api_key_env"),
    asrModel: toml.asr.model,

    exaApiKey: secretFromEnv(toml.services.exa_api_key_env, "services.exa_api_key_env"),
    musicApiBaseUrl: toml.services.music_api_base_url,
    youtubeApiKey: secretFromEnv(toml.services.youtube_api_key_env, "services.youtube_api_key_env"),
    wdTaggerUrl: toml.services.wd_tagger_url,
    animeClassifyUrl: toml.services.anime_classify_url,

    ocrEnabled: toml.ocr.enabled,
    ocrMaxPerTick: toml.ocr.max_per_tick,
    ocrMinConfidence: toml.ocr.min_confidence,

    threadAgeScale: toml.pressure.thread_age_scale,
    delta: toml.pressure.delta,
    // ADR-111: betaR 已迁移为 P3_BETA_R 常量（不再作为运行时配置）
    eta: toml.pressure.eta,
    k: toml.pressure.k,
    mu: toml.pressure.mu,
    d: toml.pressure.d,

    kappa: toml.pressure.kappa,

    kSteepness: toml.pressure.k_steepness,
    kappaProspect: toml.pressure.kappa_prospect,
    kappaAdaptAlpha: toml.pressure.kappa_adapt_alpha,

    actionRateWindow: toml.action_rate.window_s,
    rateCap: {
      private: toml.action_rate.cap_private,
      group: toml.action_rate.cap_group,
      channel: toml.action_rate.cap_channel,
      bot: toml.action_rate.cap_bot,
    },
    actionRateFloor: toml.action_rate.floor,

    learningRate: toml.personality.learning_rate,
    meanReversion: toml.personality.mean_reversion,
    piMin: toml.personality.pi_min,
    piHome: toml.personality.pi_home,

    dtMin: toml.time.dt_min_ms,
    dtMax: toml.time.dt_max_ms,
    kappaT: toml.time.kappa_t,
    snapshotIntervalS: toml.time.snapshot_interval_s,
    stalenessThreshold: toml.time.staleness_threshold,

    idleThreshold: toml.idle.threshold_s,

    s10LeakProb: toml.idle.s10_leak_prob,
    moodHalfLife: toml.personality.mood_half_life_s,

    wakeupOfflineThresholdS: toml.wakeup.offline_threshold_s,
    wakeupGraduationTicks: toml.wakeup.graduation_ticks,

    thetaSilenceS: toml.mode.theta_silence_s,
    thetaLowAPI: toml.mode.theta_low_api,
    thetaMem: toml.mode.theta_mem,

    quietWindowStart: toml.dormant.quiet_window_start,
    quietWindowEnd: toml.dormant.quiet_window_end,
    thetaDormantAPI: toml.dormant.theta_api,
    dormantWakeTier: toml.dormant.wake_tier,

    timezoneOffset: toml.time.timezone_offset,
    rhythmProfileRebuildIntervalS: toml.time.rhythm_profile_rebuild_interval_s,

    exploration: {
      maxJoinsPerDay: toml.exploration.max_joins_per_day,
      maxSearchPerHour: toml.exploration.max_search_per_hour,
      joinCooldownMs: toml.exploration.join_cooldown_ms,
      searchCooldownMs: toml.exploration.search_cooldown_ms,
      postJoinSearchCooldownMs: toml.exploration.post_join_search_cooldown_ms,
      silentDurationS: toml.exploration.silent_duration_s,
      apprenticeDurationS: toml.exploration.apprentice_duration_s,
      apprenticeMaxMessages: toml.exploration.apprentice_max_messages,
      circuitBreakerThreshold: toml.exploration.circuit_breaker_threshold,
      circuitBreakerOpenMs: toml.exploration.circuit_breaker_open_ms,
    },

    socialCost: SocialCostConfigSchema.parse(DEFAULT_SOCIAL_COST_CONFIG),

    saturationCost: SaturationCostConfigSchema.parse(DEFAULT_SATURATION_COST_CONFIG),

    beliefBeta: toml.belief.beta,
    beliefGamma: toml.belief.gamma,
    thompsonEta: toml.belief.thompson_eta,
    iausDeterministic: toml.iaus.deterministic,
    habituationAlpha: toml.iaus.habituation_alpha,
    habituationHalfLifeS: toml.iaus.habituation_half_life_s,
    momentumBonus: toml.iaus.momentum_bonus,
    momentumDecayMs: toml.iaus.momentum_decay_ms,
    curveModulationStrength: toml.iaus.curve_modulation_strength,
    desireBoost: toml.iaus.desire_boost,
    moodNudgeScale: toml.personality.mood_nudge_scale,

    attentionDebt: { delta: toml.attention_debt.delta },
    budgetZones: optionalBudgetZones(toml.budget_zones),

    peripheral: {
      perChannelCap: toml.peripheral.per_channel_cap,
      totalCap: toml.peripheral.total_cap,
      minTextLength: toml.peripheral.min_text_length,
    },

    generators: {
      digestHour: toml.generators.digest_hour,
      reflectionDay: toml.generators.reflection_day,
      reflectionHour: toml.generators.reflection_hour,
      anomalyZThreshold: toml.generators.anomaly_z_threshold,
    },

    focusWhitelistPath: focusWhitelist.path,
    focusWhitelist: focusWhitelist.targets,

    operatorChannelId:
      toml.telegram.operator_channel_id || (telegramAdmin ? telegramChannelId(telegramAdmin) : ""),

    telegramAdmin,

    logLevel: toml.log.level,
  };
}
