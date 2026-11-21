/**
 * 闭环对照的组别：都从生产注册表与压力场的生产组成（PRODUCTION）派生，不各自抄配置。
 * 一组就是压力场的另一种组成（换掉、拿掉或加上一样东西）或注册表里换掉、拿掉一个机制。
 * tune 是敏感度扫描的覆盖（--lambda0），对所有压力场组一样生效。
 */
import { closeness } from "../mechanisms/closeness.js";
import { errands } from "../mechanisms/errands.js";
import { examples } from "../mechanisms/examples.js";
import { failures } from "../mechanisms/failures.js";
import { closenessCalibrated, createFamiliar, familiar } from "../mechanisms/familiar.js";
import { withMissed } from "../mechanisms/missed.js";
import { paletteCharm, paletteComposite } from "../mechanisms/palette.js";
import { presence } from "../mechanisms/presence.js";
import { bedtime, createBedtime } from "../mechanisms/pressure/bedtime.js";
import { contextWith } from "../mechanisms/pressure/context.js";
import {
  affect,
  awake,
  body,
  createPressure,
  dwell,
  echo,
  febDiary,
  floor,
  floorWake,
  follow,
  GROUP_TURN,
  glance,
  life,
  PRODUCTION,
  type PressureFeatures,
  people,
  phone,
  pressureProduction,
  sleep,
  thought,
  topics,
} from "../mechanisms/pressure/index.js";
import { PEOPLE_ALL } from "../mechanisms/pressure/people.js";
import { mechanisms } from "../mechanisms/registry.js";
import { roomVoiceGolden } from "../mechanisms/room-voice.js";
import { sceneFacts } from "../mechanisms/scene-facts.js";
import { expression, voice } from "../mechanisms/voice.js";
import { affordances } from "../mind/affordances.js";
import { composeMind, type Mechanism } from "../mind/mechanism.js";
import { type Rotating, type RotationUnit, rotating } from "../mind/rotation.js";

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
  life: life({ occupies: true, warm: true }),
};

export function arms(tune: { lambda0?: number }): Record<string, readonly Mechanism[]> {
  const p = (c: PressureFeatures): Mechanism =>
    createPressure(affordances, c, tune.lambda0 === undefined ? {} : { lambda0: tune.lambda0 });
  const rest = mechanisms.filter((m) => m !== pressureProduction);
  // 压力场没换的组用生产那一个（同一个对象）：线上轮换（rotation.ts）按对象认出哪些机制换了。
  const prod = (c: PressureFeatures = {}) => [
    Object.keys(c).length === 0 && tune.lambda0 === undefined
      ? pressureProduction
      : p({ ...PRODUCTION, ...c }),
    ...rest,
  ];
  /** 2 月的日记原样：它的示范已经带着先想后说，内心独白就不再带自己的示范。 */
  const feb = {
    diary: febDiary({ thinking: false }),
    thought: thought({ examples: false, carry: true }),
  };
  return {
    /** 生产注册表（扫描时把生产压力场换成同样组成加覆盖的版本）。 */
    production:
      tune.lambda0 === undefined
        ? mechanisms
        : mechanisms.map((m) => (m === pressureProduction ? p(PRODUCTION) : m)),
    /** 候选：世界在线份额。 */
    awake: prod({ awake }),
    /** 对照：2 月的日记原样（她顺手写，eval-artifacts/emotion/feb-diary.md）。 */
    diary: prod(feb),
    /** 对照：2 月日记加行动回声（ADR-102）。 */
    "diary-echo": prod({ ...feb, echo }),
    /** 对照：2 月日记加内心独白（2 月两个峰值时刻每轮都有 think）。 */
    "diary-thought": prod({
      diary: febDiary({ thinking: true }),
      thought: thought({ examples: false }),
    }),
    /** 消融：去掉能力事实（G1b）。 */
    "no-body": prod({ body: undefined }),
    /** 候选 G2c：第一反应式的独白，没有日记。 */
    inner: prod({ thought: thought({ examples: true }) }),
    /** 候选 G3b：行动回声加两句行动自觉。 */
    echo: prod({ echo }),
    /**
     * 候选 R04：她自己开、推进、了结的事（2 月 threads.mod）。没测过，是加上它的一组；
     * 和 production 比就是 no-topics 的消融。
     */
    topics: prod({ topics }),
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
    /** 候选 groupturn：话题有关、想接某个人的话、在场（eval-artifacts/groupturn/prereg.md）。 */
    groupturn: prod(GROUP_TURN),
    /** 消融：groupturn 去掉话题有关。 */
    "groupturn-no-topic": prod({ ...GROUP_TURN, topic: undefined }),
    /** 消融：groupturn 去掉想接某个人的话。 */
    "groupturn-no-bond": prod({ ...GROUP_TURN, bond: undefined }),
    /** 消融：groupturn 去掉在场（对话弧）。 */
    "groupturn-no-floor": prod({ ...GROUP_TURN, floor: undefined }),
    /** 消融：去掉群里的对话弧（她在这段对话里，M27）。 */
    "no-floor": prod({ floor: undefined }),
    /** 竞争者：只有 2 月"说完 5 分钟内别人的话叫醒她再看一眼"（ADR-66 F1），代价不变、看过不放下。 */
    "floor-wake": prod({ floor: floorWake }),
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
    /** 消融：生活照样过、照样写成事实，但手上的事不占用她（只看事实送达，不改时机）。 */
    "life-facts": prod({ ...OLD_LIFE, life: life({ occupies: false, warm: true }) }),
    /**
     * 候选（her-life 第 1 片，eval-artifacts/her-life/prereg-1.md）：醒着时手上一直有事（Barabási 的 L = 2），
     * 时段里的事之外是刷手机、看书、收拾屋子、听歌（life.ts FILLERS）。
     */
    "life-l2": prod({ ...OLD_LIFE, life: life({ occupies: true, warm: true, fill: true }) }),
    /**
     * 候选（her-life 第 1 片第 3 轮，eval-artifacts/her-life/prereg-3.md）：life-l2，加上做事时隔一阵瞄一眼手机
     * （Andrews 2015 每天约 46.6 次不到 30 秒的使用），瞄的那 15 秒不付手上的事的代价。
     */
    "life-l2-glance": prod({
      ...OLD_LIFE,
      life: life({ occupies: true, warm: true, fill: true, glance: true }),
    }),
    /**
     * 候选（第 1 片第 5 轮，eval-artifacts/her-life/prereg-5.md）：life-l2-glance，瞄的那一眼扫过各个会话，
     * 有新消息的都再问一次要不要醒（不只节律排第一的那一个）。
     */
    "life-l2-glance-scan": prod({
      ...OLD_LIFE,
      life: life({ occupies: true, warm: true, fill: true, glance: true, scan: true }),
    }),
    /** 消融：life-l2 的事照样过、照样写成事实，但不占用她（数据回路：调用与 life-facts 相同）。 */
    "life-l2-facts": prod({ ...OLD_LIFE, life: life({ occupies: false, warm: true, fill: true }) }),
    /**
     * 对照：平行世界之前的身份（"你只活在 Telegram 里"、没有她自己的生活）；人格要配旧版
     * （--persona 指向 git show 2026-11-12 之前的 SOUL.md）。
     */
    "telegram-only": prod({ ...OLD_LIFE, body: body("telegram"), life: undefined }),
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
    /** 消融：示例换回旧的同会话真人示例（examples.ts，空库时退回技术口气的默认示例）；生产是调色盘。 */
    "old-examples": prod().map((m) => (m === paletteComposite ? examples : m)),
    /** 对照：dwell 之前的对话弧，说完 5 分钟内算在场（floor，eval-artifacts/dwell/prereg.md 的 production）。 */
    floor: prod({ floor }),
    /** 消融：dwell 去掉"对话走过她 K 轮就结束"，只剩冷下来和她决定不说。 */
    "dwell-no-passby": prod({ floor: dwell({ passBy: false, rejection: true }) }),
    /** 消融：生产（familiar）去掉先验，只有校准（closeness-calibrated，以前叫 familiar-no-prior）。 */
    "calibrated-only": withCloseness(prod(), closenessCalibrated),
    /** 对照：校准之前的排名分层（第一次往来的人就是"很亲近，你们几乎天天聊"）。 */
    "closeness-ranked": withCloseness(prod(), closeness),
    /** 消融：familiar 去掉校准（有往来的人仍按排名分层写），只留先验。 */
    "familiar-no-calibration": withCloseness(
      prod(),
      createFamiliar("familiar-no-calibration", { prior: true, calibrated: false }),
    ),
    /** 候选 M25：节律到点时只要看一眼就不叫醒模型（eval-artifacts/glance/prereg.md）。 */
    glance: prod({ glance: glance() }),
    /** 消融：看一眼照样排序，但表情仍能在节律路径上叫醒她。 */
    "glance-react": prod({ glance: glance({ reactions: true }) }),
    /** 候选：她看着这段对话、还没开口时，别人的话也叫醒她（旁观者；eval-artifacts/participation/prereg.md）。 */
    follow: prod({ follow: follow() }),
    /** 消融：在对话里看过、不说之后不再看着（dwell 的 declined 照旧结束一切）。 */
    "follow-no-skip": prod({ follow: follow({ skip: false, gate: "look", reader: false }) }),
    /** 消融：看着的时候再看一眼也按最好的意愿 NSV > 0 算（和 dwell 一样，收对别人的代价）。 */
    "follow-will": prod({ follow: follow({ skip: true, gate: "will", reader: false }) }),
    /** 候选：follow，在对话里时提示词也照旧写"没人找你"（别人没冲着她说的那些话，participation 偏离）。 */
    "follow-reader": prod({ follow: follow({ skip: true, gate: "look", reader: true }) }),
    /** 候选：follow，只有旁观时按"看着就看得到"叫醒；在对话里（dwell）照旧按 NSV（participation 偏离）。 */
    "follow-watch": prod({ follow: follow({ skip: true, gate: "look-watch", reader: false }) }),
    /** 候选：只在对话里（dwell）按 look 的门叫醒、提示词照旧"没人点你"；旁观不变（eval-artifacts/dwell-look/prereg.md）。 */
    "dwell-look": prod({ floor: dwell({ passBy: true, look: true, rejection: true }) }),
    /** 消融：follow 加看一眼（节律到点只看一眼时也开始看着，之后的新话照样叫醒她）。 */
    "follow-glance": prod({ follow: follow(), glance: glance() }),
    /**
     * 消融：去掉 warmth（心情和想不想说话都按常态为 0.05、0 的旧动力学；场景里没人点她时开口 92% → 85%，
     * eval-artifacts/context/）。
     */
    "no-warmth": prod({
      ...OLD_LIFE,
      affect: affect({ noise: true, lonely: true, rejection: true }),
      life: life({ occupies: true }),
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
    "warmth-no-life": prod({ ...OLD_LIFE, life: life({ occupies: true }) }),
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
    /** 候选（PLAN 第 42/54 件，机制层）：roomVoiceGolden（去数字+滤水词）排在 paletteCharm 之前。 */
    "charm-mechanisms": [...(tune.lambda0 === undefined ? mechanisms : prod())]
      .filter((m) => m !== roomVoiceGolden && m !== paletteComposite)
      .concat([roomVoiceGolden, paletteCharm]),
  };
}

/**
 * 线上轮换和回放共用的组装（mind/rotation.ts）：生产和这个组挂成两套。services 是外壳此刻提供的服务，两套都按它
 * 组合（和 registry.ts productionMechanisms 一样）；回放给 null，和单组回放一样不组合。
 */
export function rotationOf(
  config: { candidate: string; seed: string; unit: RotationUnit | null },
  services: readonly string[] | null,
): Rotating {
  const candidate = arms({})[config.candidate];
  if (!candidate || config.candidate === "production") {
    throw new Error(
      `unknown candidate arm ${config.candidate}; arms: ${Object.keys(arms({})).join(" ")}`,
    );
  }
  return rotating(
    {
      candidate: config.candidate,
      seed: config.seed,
      ...(config.unit ? { unit: config.unit } : {}),
    },
    services ? composeMind(mechanisms, services).mechanisms : mechanisms,
    services ? composeMind(candidate, services).mechanisms : candidate,
  );
}
