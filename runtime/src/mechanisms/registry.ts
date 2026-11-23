import {
  affordances,
  type CapabilityResolver,
  PLATFORM_ACT_KINDS,
  type PlatformCapabilities,
  platformSupports,
  resolveCapabilities,
} from "../mind/affordances.js";
import { composeMind, type Mechanism } from "../mind/mechanism.js";
import { errands } from "./errands.js";
import { failures } from "./failures.js";
import { closenessCalibrated, familiar } from "./familiar.js";
import { language } from "./language.js";
import { missed } from "./missed.js";
import { paletteAuthentic } from "./palette.js";
import { patience, typingPatience } from "./patience.js";
import { presence } from "./presence.js";
import {
  createPressure,
  type PlatformAttentionOptions,
  PRODUCTION,
  pressureProduction,
} from "./pressure/index.js";
import { roomVoiceGolden } from "./room-voice.js";
import { sceneFacts } from "./scene-facts.js";
import { stickerBag } from "./stickers.js";
import { expression, voice } from "./voice.js";

/**
 * 所有已移植的机制：生产的，加上组别拿来替换生产的那几个（sim/will-arms.ts）。压力场的候选和对照不在这里，
 * 它们是压力场的另一种组成，只在组别里。新增机制只改这里。
 */
export const allMechanisms: readonly Mechanism[] = [
  patience,
  typingPatience,
  language,
  presence,
  failures,
  missed,
  errands,
  pressureProduction,
  voice,
  expression,
  paletteAuthentic,
  stickerBag,
  familiar,
  closenessCalibrated,
  roomVoiceGolden,
  sceneFacts,
];

/**
 * 生产使用的机制：通过各自消融门槛的才放进来（压力场的生产组成见 pressure/index.ts PRODUCTION）。
 * 每一部分做什么、依据是什么，写在 capabilities.md 对应的条目；读数和预注册在 eval-artifacts/<名字>/，
 * 把它加进这张表的那次提交说明里有判定。每一部分的消融组在 sim/will-arms.ts。
 */
export const mechanisms: readonly Mechanism[] = [
  pressureProduction,
  familiar,
  paletteAuthentic,
  stickerBag,
  typingPatience,
  language,
  presence,
  failures,
  errands,
  voice,
  expression,
  /**
   * 聊天现场的客观事实（PLAN 第 55 件第 4 项，ADR-276，2026-11-14 上线）：消息上的表情和人数、改过、转发自谁、贴纸那套，
   * 群人数、群主和管理员，禁发的动作不给（意愿层读同一份禁发，pressure/will.ts）；沉底的找她的话带回记录（压力场的
   * context 那一格）。依据：40 个真实时刻、一个 opus 判别员（挑毛病第二版），毛病更重 候选 5、生产 4、平局 20，
   * 输的几处都不来自新事实（eval-artifacts/scene-facts/prereg.md）。第 44 件想分享的劲的依据写在
   * 压力场的组成里：零成本普查第六遍（每会话每天最多分享 2 次，被找时和生产逐条相同）、真模型 60 个时刻毛病更重 2 比 4、
   * 平局 30、提到那件东西 4 次硬塞 0（docs/research/desire-2026-11-13.md）。研究员 2026-11-14："激进改进、鼓励大胆尝试出错"，
   * 不等第 51 件的轮换。消融组 no-scene-facts、no-desire。排在 room-voice 前面：room-voice 只给参考，要在最后。
   */
  sceneFacts,
  /**
   * 这个群的人平时怎么打字（PLAN 第 42、49 件，2026-11-13 上线，和 Gemini 改稿的说明文字、示例、人格"你说话的样子"
   * 三处改动一起）：real-v1 开发集两遍，挑毛病 24 : 8，正面问法 37 : 19，风格五项里四项落进同群活跃真人的 p10–p90；
   * 研究员 2026-11-13 同意人格改动。证据 docs/adr/282-speech-style-and-room-voice.md。放在最后：参考里排在示例后面。
   */
  roomVoiceGolden,
];

/**
 * 按平台能力声明过滤对外动作：平台不支持的不进提示词、不进 settle；平台独有或按平台开启的
 * gated 动作（如 QQ 的撤回 unsend）按会话所属平台提供。没有状态，不影响日志折叠。
 */
function platformCapabilityMechanism(
  capabilities: PlatformCapabilities | CapabilityResolver,
): Mechanism {
  const resolve = resolveCapabilities(capabilities);
  const mayUnsend = typeof capabilities === "function" || capabilities.acts.has("unsend");
  return {
    name: "platform-capabilities",
    ...(mayUnsend
      ? {
          affordances: ["unsend"] as const,
          affordancesIn: (scope) => (resolve?.(scope)?.acts.has("unsend") ? ["unsend"] : []),
        }
      : {}),
    withholds: (chat) =>
      PLATFORM_ACT_KINDS.filter(
        (kind) => !platformSupports(resolve?.(chat.scope), kind, chat.chatType),
      ),
  };
}

/**
 * 外壳提供的服务决定哪些机制激活（composeMind）：关掉执行代理时（index.ts：没有 EXA_API_KEY 或 ALICE_ERRANDS=off）
 * errands 缺 errand，不激活，SDK 里就没有 look_up。errands 没有状态，带不带它 fold 出的状态相同。
 * 传入平台能力声明（或按会话查询的解析器）时，意愿层（pressure）和发言/落盘层同步按所属平台收口。
 */
export function productionMechanisms(
  errandsOn: boolean,
  capabilities?: PlatformCapabilities | CapabilityResolver,
  attention?: PlatformAttentionOptions,
): readonly Mechanism[] {
  const list = capabilities ? platformScoped(capabilities, attention)(mechanisms) : mechanisms;
  return composeMind(list, errandsOn ? ["errand"] : []).mechanisms;
}

/**
 * 让一套机制按平台能力收口：生产的压力场换成带能力声明的那一个，末尾加上平台能力那一项。
 * 返回的函数对几套机制（线上轮换的生产和候选）共用同一批对象：轮换按对象认出哪些机制换了（mind/rotation.ts）。
 */
export function platformScoped(
  capabilities: PlatformCapabilities | CapabilityResolver,
  attention?: PlatformAttentionOptions,
): (list: readonly Mechanism[]) => readonly Mechanism[] {
  const pressure = createPressure(affordances, PRODUCTION, {
    name: "pressure-production",
    capabilities,
    ...(attention ? { attention } : {}),
  });
  const scoped = platformCapabilityMechanism(capabilities);
  return (list) => [...list.map((m) => (m === pressureProduction ? pressure : m)), scoped];
}

export function byName(names: readonly string[]): readonly Mechanism[] {
  return names.map((name) => {
    const m = allMechanisms.find((x) => x.name === name);
    if (!m) throw new Error(`unknown mechanism: ${name}`);
    return m;
  });
}
