/**
 * 闭环对照的组别：都从生产注册表与压力场的生产组成（PRODUCTION）派生，不各自抄配置。
 * 一组就是压力场的另一种组成（换掉、拿掉或加上一样东西）或注册表里换掉、拿掉一个机制。
 * tune 是敏感度扫描的覆盖（--lambda0），对所有压力场组一样生效。
 */
import { errands } from "../mechanisms/errands.js";
import { failures } from "../mechanisms/failures.js";
import { closenessCalibrated, createFamiliar, familiar } from "../mechanisms/familiar.js";
import { withMissed } from "../mechanisms/missed.js";
import { paletteAuthentic, paletteCharmV2 } from "../mechanisms/palette.js";
import { presence } from "../mechanisms/presence.js";
import { bedtime, createBedtime } from "../mechanisms/pressure/bedtime.js";
import { contextWith } from "../mechanisms/pressure/context.js";
import {
  affect,
  attachmentLoop,
  createDesire,
  createFairness,
  createPressure,
  createReach,
  dwell,
  life,
  PEOPLE_LIVE,
  type PlatformAttentionOptions,
  PRODUCTION,
  type PressureFeatures,
  people,
  phone,
  pressureProduction,
  reflectDiaryEmotive,
  reflectDiaryFlow,
  sleep,
  thought,
} from "../mechanisms/pressure/index.js";
import { PEOPLE_ALL } from "../mechanisms/pressure/people.js";
import { mechanisms, platformScoped } from "../mechanisms/registry.js";
import { roomVoiceGolden } from "../mechanisms/room-voice.js";
import { sceneFacts } from "../mechanisms/scene-facts.js";
import { stickerBag } from "../mechanisms/stickers.js";
import { expression, voice } from "../mechanisms/voice.js";
import {
  affordances,
  type CapabilityResolver,
  type PlatformCapabilities,
} from "../mind/affordances.js";
import { composeMind, type Mechanism } from "../mind/mechanism.js";
import { type Rotating, type RotationUnit, rotating } from "../mind/rotation.js";
import type { SpeechFormat } from "../speech/decision.js";

/** 把生产注册表里的关系事实（closeness-calibrated）换成另一个机制，位置不变。 */
const withCloseness = (list: readonly Mechanism[], m: Mechanism): readonly Mechanism[] =>
  list.map((x) => (x === familiar ? m : x));
/** 生产的 warmth（心情的常态、评价强度、被人找是一次评价、口气不好的来找不推向开心都开着）。 */
const WARM = { home: true, relevance: true, bids: true, tone: true } as const;
/**
 * 身体（life-body）之前的作息和生活：作息带上"她不在时别处来了多少"，生活是 life.ts。
 * 用到它的组对照的是这个旧底上的变化，不是新生产减一项。
 */
const OLD_LIFE: PressureFeatures = {
  sleep: withMissed(bedtime),
  life: life({ warm: true }),
};

export function arms(tune: {
  lambda0?: number;
  /** 平台能力声明（线上轮换）：组里新建的压力场按它收口意愿层；不给时和以前逐字节相同。 */
  capabilities?: PlatformCapabilities | CapabilityResolver;
  /** 多平台注意力层级（线上轮换与生产保持同一套配置）。 */
  attention?: PlatformAttentionOptions;
}): Record<string, readonly Mechanism[]> {
  const p = (c: PressureFeatures): Mechanism =>
    createPressure(affordances, c, {
      ...(tune.lambda0 === undefined ? {} : { lambda0: tune.lambda0 }),
      ...(tune.capabilities ? { capabilities: tune.capabilities } : {}),
      ...(tune.attention ? { attention: tune.attention } : {}),
    });
  const rest = mechanisms.filter((m) => m !== pressureProduction);
  // 压力场没换的组用生产那一个（同一个对象）：线上轮换（rotation.ts）按对象认出哪些机制换了。
  const prod = (c: PressureFeatures = {}) => [
    Object.keys(c).length === 0 && tune.lambda0 === undefined
      ? pressureProduction
      : p({ ...PRODUCTION, ...c }),
    ...rest,
  ];
  const timelineAffectMechanisms = (): readonly Mechanism[] =>
    [
      ...prod({
        people: people(PEOPLE_LIVE),
        diary: reflectDiaryFlow,
        thought: thought({ examples: true, carry: true, composite: true, inline: true }),
        echo: undefined,
        affect: affect({
          noise: true,
          lonely: true,
          warmth: { home: true, relevance: true, bids: false, tone: true },
          rejection: true,
          feedback: true,
          body: true,
          willDrive: true,
          inline: true,
        }),
      }),
    ]
      .filter((m) => m !== roomVoiceGolden && m.name !== "palette" && m.name !== "sticker-bag")
      .concat([roomVoiceGolden, paletteCharmV2, stickerBag]);
  return {
    /** 生产注册表（扫描时把生产压力场换成同样组成加覆盖的版本）。 */
    production:
      tune.lambda0 === undefined
        ? mechanisms
        : mechanisms.map((m) => (m === pressureProduction ? p(PRODUCTION) : m)),
    /** 消融：去掉能力事实（G1b）。 */
    "no-body": prod({ body: undefined }),
    /** 消融：去掉反思式日记。 */
    "no-diary": prod({ diary: undefined }),
    /** 消融：去掉内心独白的灰度（生产里一半会话开着）。 */
    "no-inner": prod({ thought: undefined }),
    /** 消融：去掉"记录最后连着几条是你发的"。 */
    "no-presence": prod().filter((m) => m !== presence),
    /** 消融：去掉"刚才那个动作没做成"的事实。 */
    "no-failures": prod().filter((m) => m !== failures),
    /** 消融（旧底）：去掉"她不在时别处来了多少"。 */
    "no-missed": prod({ ...OLD_LIFE, sleep: bedtime }),
    /** 消融：去掉群里的对话弧（她在这段对话里，M27）。 */
    "no-floor": prod({ floor: undefined }),
    /** 消融：去掉 people（R05、R08、S07）。 */
    "no-people": prod({ people: undefined }),
    /** 消融：people 去掉反思时记下的关于人的事（R05）。 */
    "people-no-facts": prod({ people: people({ ...PEOPLE_ALL, facts: false }) }),
    /** 消融：people 去掉她自己说过的事（R06）。 */
    "people-no-self": prod({ people: people({ ...PEOPLE_ALL, self: false }) }),
    /** 消融：people 去掉社交周边视觉（S07）。 */
    "people-no-peripheral": prod({ people: people({ ...PEOPLE_ALL, peripheral: false }) }),
    /**
     * 消融：去掉查一下。生产组里执行代理在回放里真办（带缓存，sim/errand-cache.ts，每件约 0.02 美元）。
     */
    "no-errands": prod().filter((m) => m !== errands),
    /** 消融：去掉她自己的生活（life.ts）。 */
    "no-life": prod({ ...OLD_LIFE, life: undefined }),
    /** 消融：去掉发语音（A16）。 */
    "no-voice": prod().filter((m) => m !== voice),
    /** 消融：去掉改自己刚发的消息、跟着复读（A13、A27）。 */
    "no-expression": prod().filter((m) => m !== expression),
    /** 消融：三样一起去掉（发语音、改消息、复读）。 */
    "no-expressive": prod().filter((m) => m !== voice && m !== expression),
    /**
     * 消融：去掉她的心情（R01/R02/R12）：没有心情那一行、没有 feel、反思时不写此刻的心情。
     * 2026-11-12 之前这一组换回的是压力场记忆里的旧心情那一行；那一份心情删了（她只有一份心情），
     * 和旧动力学（只有评价和回归）比用 affect-calm。
     */
    "no-affect": prod({ affect: undefined }),
    /** 消融：affect 去掉外壳的波动（只剩评价和回归）。 */
    "affect-calm": prod({
      affect: affect({ noise: false, lonely: true, warmth: WARM, rejection: true }),
    }),
    /** 消融：affect 去掉"很久没人找你"那一句。 */
    "affect-unsought": prod({
      affect: affect({ noise: true, lonely: false, warmth: WARM, rejection: true }),
    }),
    /** 消融：去掉第一次私聊、找群和转发（reach），连同第一次私聊的节奏（fairness）。 */
    "no-reach": prod({ reach: undefined, fairness: undefined }),
    /** 消融：dwell 去掉"对话走过她 K 轮就结束"，只剩冷下来和她决定不说。 */
    "dwell-no-passby": prod({ floor: dwell({ passBy: false, rejection: true }) }),
    /** 消融：生产（familiar）去掉先验，只有校准（closeness-calibrated，以前叫 familiar-no-prior）。 */
    "calibrated-only": withCloseness(prod(), closenessCalibrated),
    /** 消融：familiar 去掉校准（有往来的人仍按排名分层写），只留先验。 */
    "familiar-no-calibration": withCloseness(
      prod(),
      createFamiliar("familiar-no-calibration", { prior: true, calibrated: false }),
    ),
    /**
     * 消融：去掉 warmth（心情和想不想说话都按常态为 0.05、0 的旧动力学；场景里没人点她时开口 92% → 85%，
     * eval-artifacts/context/）。
     */
    "no-warmth": prod({
      ...OLD_LIFE,
      affect: affect({ noise: true, lonely: true, rejection: true }),
      life: life({}),
    }),
    /** 消融：warmth 去掉"被人找是一次评价"，只剩常态、评价强度和想不想说话。 */
    "warmth-no-bids": prod({
      affect: affect({
        noise: true,
        lonely: true,
        warmth: { home: true, relevance: true, bids: false },
        rejection: true,
      }),
    }),
    /** 消融：warmth 的想不想说话换回常态为 0 的随机游走（只看心情那一半）。 */
    "warmth-no-life": prod({ ...OLD_LIFE, life: life({}) }),
    /** 消融：去掉 go_to_bed，作息照旧是固定的一天。 */
    "no-bedtime": prod({ ...OLD_LIFE, sleep: withMissed(sleep) }),
    /** 消融：照样先想后说，想过的不再读回下一轮（和 no-inner 一起分开读回与先想后说）。 */
    "inner-no-readback": prod({ thought: thought({ examples: true, readBack: false }) }),
    /** 消融：群聊记录只截最后 30 条，不带回被引用的那句（context.ts）。 */
    "no-context": prod({ context: undefined }),
    /** 消融：去掉这个群的人平时怎么打字（room-voice.ts roomVoiceGolden）。 */
    "no-room-voice": prod().filter((m) => m !== roomVoiceGolden),
    /**
     * 候选（PLAN 第 51 件，docs/research/phone-focus-2026-11-13.md）：她拿着手机才看得到没人找她的会话，没人找时按
     * 真人开始一段的节奏拿起，最后一件事之后真人的段间分界放下；手上有聊着的会话时节律只看那几个（phone.ts）。
     * 改的是叫醒，线上轮换按她整体、按天切。
     */
    phone: prod({ ...OLD_LIFE, phone }),
    /** 消融：去掉想分享的劲和叫醒她的原因（PLAN 第 44 件；desire.ts、why.ts）。 */
    "no-desire": prod({ desire: undefined }),
    /** 消融：去掉现场事实（PLAN 第 55 件第 4 项；scene-facts.ts、context.ts mentions）。 */
    "no-scene-facts": prod({ context: contextWith() }).filter((m) => m !== sceneFacts),
    /** 候选（PLAN 第 39 件）：随时可去睡（白天小睡 90 分钟，夜间到作息醒来）。 */
    "bedtime-anytime": prod({
      ...OLD_LIFE,
      sleep: withMissed(createBedtime({ anytime: true })),
    }),
    /**
     * 候选 charm-sticker-v1（ADR-297 Step 2）：解开中文比喻与「发了字不补贴纸」压抑、
     * 保留活跃群开口示范并删掉 4 条僵硬沉默示范、把真实贴纸画面描述从事件+内置词表送进发言卡。
     */
    "charm-sticker-v1": [...(tune.lambda0 === undefined ? mechanisms : prod())]
      .filter((m) => m !== roomVoiceGolden && m.name !== "palette" && m.name !== "sticker-bag")
      .concat([roomVoiceGolden, paletteCharmV2, stickerBag]),
    /**
     * 候选 affect-flow-v1（ADR-297 Step 3）：在 charm-sticker-v1 之上接通情感流动三处断点：
     * 1. 私聊实时跨群余光（PEOPLE_LIVE）；
     * 2. 跨会话高重要度日记余韵不因短暂开口被 spent 一刀抹掉（reflectDiaryFlow）；
     * 3. 心情有界调制内在驱动（affect.willDrive）。
     */
    "affect-flow-v1": [
      ...prod({
        people: people(PEOPLE_LIVE),
        diary: reflectDiaryFlow,
        affect: affect({
          noise: true,
          lonely: true,
          warmth: WARM,
          rejection: true,
          feedback: true,
          body: true,
          willDrive: true,
        }),
      }),
    ]
      .filter((m) => m !== roomVoiceGolden && m.name !== "palette" && m.name !== "sticker-bag")
      .concat([roomVoiceGolden, paletteCharmV2, stickerBag]),
    /**
     * 候选（authentic-palette）：基于跨学科真实性发现的真我情绪调色盘。
     * 保留 loop-v2 骨架 + stickerBag + roomVoiceGolden，将示例调色盘升级为带心境感知的 paletteAuthentic。
     */
    "authentic-palette": [
      ...prod({
        people: people(PEOPLE_LIVE),
        diary: reflectDiaryFlow,
        thought: thought({ examples: true, carry: true, composite: true }),
        reach: createReach({ groupForward: true }),
        desire: createDesire({ shareId: true, groupForward: true }),
        affect: affect({
          noise: true,
          lonely: true,
          warmth: WARM,
          rejection: true,
          feedback: true,
          body: true,
          willDrive: true,
        }),
      }),
    ]
      .filter((m) => m !== roomVoiceGolden && m.name !== "palette" && m.name !== "sticker-bag")
      .concat([roomVoiceGolden, paletteAuthentic, stickerBag]),
    /**
     * 候选（emergent-loop-v1，ADR-299）：上如其下、下如其上的完整“情—意—忆”贯通候选。
     * 下：SOUL.md + paletteAuthentic；上：attachmentLoop（按人慢印记与主动回响）+ reflectDiaryEmotive（心震非对称回忆）。
     */
    "emergent-loop-v1": [
      ...prod({
        people: people(PEOPLE_LIVE),
        diary: reflectDiaryEmotive,
        thought: thought({ examples: true, carry: true, composite: true }),
        reach: createReach({ groupForward: true }),
        desire: createDesire({ shareId: true, groupForward: true }),
        attachment: attachmentLoop,
        affect: affect({
          noise: true,
          lonely: true,
          warmth: WARM,
          rejection: true,
          feedback: true,
          body: true,
          willDrive: true,
        }),
      }),
    ]
      .filter((m) => m !== roomVoiceGolden && m.name !== "palette" && m.name !== "sticker-bag")
      .concat([roomVoiceGolden, paletteAuthentic, stickerBag]),
    /**
     * 实验组（exp-timeline-affect）：时间线原位上下文（仍用 run_code + SOUL.md）。
     * 本会话内思考（inner）与情绪变化（affect）穿插回时间线原位，去掉机械「被人找 -> 开心」（bids: false）
     * 与页眉重复 echo，保留贴纸画面和跨群余光。
     */
    "exp-timeline-affect": timelineAffectMechanisms(),
    /**
     * 候选 native-lean（ADR-298 第一步，docs/spec/greenfield-native-agent.md）：生产的机制一样不换，发言改成原生工具
     * （speech/native.ts，同域合并后常驻不超过 12 个），外加两处原位升级：本会话想过的和心情变化穿插回聊天记录原位
     * （inline），群里也能转发想分享的频道帖（groupForward、帖子带编号）；第一次私聊的接受度直接进卡片（cardFacts），
     * 不再单给 check_dm。口吻是生产的 STYLE_DEFAULT。
     */
    "native-lean": prod({
      thought: thought({ examples: true, carry: true, composite: true, inline: true }),
      affect: affect({
        noise: true,
        lonely: true,
        warmth: WARM,
        rejection: true,
        feedback: true,
        body: true,
        inline: true,
      }),
      reach: createReach({ groupForward: true }),
      desire: createDesire({
        dreamFeed: true,
        personalUrge: true,
        shareId: true,
        groupForward: true,
      }),
      fairness: createFairness({ cardFacts: true }),
    }),
    /**
     * 候选 native-only（ADR-298 单因素格式对照）：生产的机制一样不换，只把发言格式切成原生工具
     * （speech/native.ts），并把第一次私聊接受度放进卡片（cardFacts）以省掉多余的 check_dm 工具。
     */
    "native-only": prod({
      fairness: createFairness({ cardFacts: true }),
    }),
    /**
     * 候选 emergent-clean-v1（第一性原理 + 学科理论对齐，2026-11-23）：
     * 1) 语境完整性（Contextual Integrity）：公开群不带入源自一对一私聊的内心独白（keepDmInDm）；
     * 2) 可供性理论（Gibson）：初次私聊接受度直接进卡片（cardFacts: true），省掉 0 调用前置工具；
     * 3) 认知负荷与提示词诚实性（ADR-210）：精简 UNRECORDED 且不与日记/独白自相矛盾（concisePeople）。
     * （注：affect.warmth.bids=false 经 3.78 天零成本普查证伪：心情出现率 0.860->0.002、p90 1.0->0.889，已撤回。）
     */
    "emergent-clean-v1": prod({
      thought: thought({ examples: true, carry: true, composite: true, keepDmInDm: true }),
      fairness: createFairness({ cardFacts: true }),
    }),
  };
}

/** 组的发言格式（speech/decision.ts SpeechFormat）；生产与既有组别返回空对象，保证逐字节不变。 */
export function armPromptConfig(arm: string): {
  format?: SpeechFormat;
  concisePeople?: boolean;
} {
  if (arm === "native-lean" || arm === "native-only") return { format: "native" };
  if (arm === "emergent-clean-v1") return { format: "native", concisePeople: true };
  return {};
}

/**
 * 线上轮换和回放共用的组装（mind/rotation.ts）：生产和这个组挂成两套。services 是外壳此刻提供的服务，两套都按它
 * 组合（和 registry.ts productionMechanisms 一样）；回放给 null，和单组回放一样不组合。
 */
export function rotationOf(
  config: { candidate: string; seed: string; unit: RotationUnit | null },
  services: readonly string[] | null,
  capabilities?: PlatformCapabilities | CapabilityResolver,
  attention?: PlatformAttentionOptions,
): Rotating {
  const found = arms({
    ...(capabilities ? { capabilities } : {}),
    ...(attention ? { attention } : {}),
  })[config.candidate];
  if (!found || config.candidate === "production") {
    throw new Error(
      `unknown candidate arm ${config.candidate}; arms: ${Object.keys(arms({})).join(" ")}`,
    );
  }
  // 两套都按平台能力与注意力层级收口（同一批对象），平台不支持的动作哪一套都不给。
  const scope = capabilities
    ? platformScoped(capabilities, attention)
    : (list: readonly Mechanism[]) => list;
  const production = scope(mechanisms);
  const candidate = scope(found);
  return rotating(
    {
      candidate: config.candidate,
      seed: config.seed,
      ...(config.unit ? { unit: config.unit } : {}),
    },
    services ? composeMind(production, services).mechanisms : production,
    services ? composeMind(candidate, services).mechanisms : candidate,
  );
}
