/**
 * 压力场的参数。每一项注明出处：论文 paper/sections/03、04，2 月代码（tag archive/feb-2026-02），
 * 或 ADR（tag archive/untracked-2026-11-10:docs/adr）。取舍理由见 eval-artifacts/trigger/pressure-fidelity.md。
 * 时间一律用毫秒。
 */
import type { ChatType } from "../../mind/events.js";
import { CLOSENESS_HALF_LIFE } from "../closeness.js";

export type Tier = 5 | 15 | 50 | 150 | 500;
export const TIERS: readonly Tier[] = [5, 15, 50, 150, 500];

const H = 3_600_000;
const D = 24 * H;

/** Dunbar 层的权重（2 月 graph/constants.ts DUNBAR_TIER_WEIGHT；论文式 500/tier 的比例过陡，2 月未用）。 */
export const TIER_WEIGHT: Record<Tier, number> = { 5: 5, 15: 3, 50: 1.5, 150: 0.8, 500: 0.3 };
/** 期望互动间隔 θ_c（ADR-113 §D3 按线上 IM 重标定）。 */
export const TIER_THETA: Record<Tier, number> = {
  5: 2 * H,
  15: 4 * H,
  50: 12 * H,
  150: 2 * D,
  500: 7 * D,
};
/** 群聊没有双边层级，2 月统一记为 150。 */
export const GROUP_TIER: Tier = 150;

// ── P1 注意力债（论文 Def P1，ADR-150 EWMS，ADR-176 tonic/phasic）──
export const UNREAD_HALF_LIFE = H;
export const KAPPA_TONIC = 1.0;
/** chat-type 注意力权重（2 月 CHAT_TYPE_WEIGHTS.attention）。 */
export const ATTENTION_CHAT: Record<ChatType, number> = { private: 3, group: 1 };

// ── P3 关系冷却（论文 Def P3，ADR-111 对数域 sigmoid）──
export const P3_TAU0 = 600_000;
export const P3_BETA = 2.5;
/** 群聊存在感：群自己 K 轮消息的时长作 θ（ADR-161 §3.4），夹在 [30 分钟, 7 天]。 */
export const GROUP_ABSENCE_ROUNDS = 10;
export const GROUP_THETA_MIN = 30 * 60_000;
export const GROUP_THETA_MAX = 7 * D;
export const GROUP_THETA_COLD = 4 * H;
export const GAP_EMA_ALPHA = 0.2;

// ── P5 回应义务（论文 Def P5；ADR-157 指数核；ADR-186 私聊群聊同一半衰期）──
export const OBLIGATION_HALF_LIFE = H;
export const RESPONSE_CHAT: Record<ChatType, number> = { private: 2, group: 1 };

// ── P6 好奇心（论文 Def P6 有界形式；Remark per-contact surprise）──
export const CURIOSITY_ETA = 0.6;
/** novelty 的滑动和用这个时间常数（论文 "最近 k 个 tick"，这里换成与 tick 长度无关的指数窗）。 */
export const NOVELTY_TAU = H;
export const NOVELTY_PER = 60_000;
export const SIGMA_HALF_COUNT = 10;
export const TAU_CURIOSITY = 3_000_000;
export const EXPECTED_SILENCE: Record<Tier, number> = {
  5: 4 * H,
  15: D,
  50: 3 * D,
  150: 14 * D,
  500: 60 * D,
};
export const EXPECTED_DAILY: Record<Tier, number> = {
  5: 6,
  15: 1,
  50: 0.33,
  150: 0.07,
  500: 0.016,
};

// ── 习惯化（论文 §3 Habituation；ADR-222）──
export const HABITUATION_TAU = 1_800_000;
export const HABITUATION_ALPHA = 0.5;

// 归一化与全局读数的 κ、声部、习惯化、外部需求：驱动表 DRIVE_SPEC（drives.ts）。

// ── 声部（论文 §4；R_v 权重来自 ADR-181；Caution 用论文 BIS 变体）──
export const PERSONALITY = { diligence: 0.25, curiosity: 0.25, sociability: 0.25, caution: 0.25 };
export const CAUTION_CONFLICT = 0.6;
export const CAUTION_NORM = 10;
export const CAUTION_RISK = 0.8;
export const UNCERTAINTY_COUNT = 10;
export const VOICE_TAU_MIN = 0.1;
export const VOICE_TAU_MAX = 0.4;
export const VOICE_TAU_C = 10;

// ── 社交成本（论文 Eq NSV；2 月 social-cost.ts 的 dist/imp/temp，去掉没有输入的 power）──
export const SOCIAL_WEIGHTS = { dist: 0.3, imp: 0.3, temp: 0.3 } as const;
export const COST_WINDOW = 1_800_000;
export const DENSITY_SCALE = 6;

// ── 饱和成本 C_sat（ADR-136：约束作为目标函数里的连续代价，不在优化之后设闸）──
export const SAT = {
  wRate: 2,
  wCool: 1.5,
  wOut: 2,
  wFail: 1.5,
  rateWindow: 3_000_000,
  rateCap: 4,
  rateCapObliged: 5,
  rateExp: 2,
  /** 连发的尺度：私聊 3、群 4（ADR-136 §2.3）；代价按 (条数/尺度)² 增长，不封顶。 */
  outCap: { private: 3, group: 4 },
  outExp: 2,
  /**
   * 对方一直不回，这个证据不会很快变弱：3 天半衰期让冷却每 ~2 天把她推回去一次、30 天里连找 18 次
   * （test/pressure-properties.test.ts S2）。2 月 B 的 3.8 天分不出 3、10、30 天（主动私聊 23、20、18 次/天，
   * 最长连找都是 2）；不消退时掉出范围（15 次/天、连找 1）。取 30 天：30 天里至多 3 次。
   */
  outHalfLife: 30 * D,
  failGamma: 0.5,
  failHalfLife: 1_800_000,
  /** proactive 冷却 τ_cool = α·θ_tier（ADR-154），群聊再乘 0.25。 */
  coolAlpha: 0.15,
  coolGroup: 0.25,
} as const;
/** 她连着说的话在这么久内算同一轮。 */
export const TURN_GAP = 90_000;
/**
 * 群里一条话接得上前一条的间隔（Elsner & Charniak 2008 只给相隔 129 秒以内的两条打分；北极星"群里接她"同一个口径）：
 * 她说完，紧挨着的下一条在这么久之内，或者她刚接的那个人在这么久之内又说话，都算有人接她。
 */
export const UPTAKE_LINK = 129_000;

// ── 义务调制的成本敏感度 λ = λ0·φ（论文 Eq lambda-modulation）──
/** ADR-60 D5 标定 λ ≈ 1.31–2.25；2 月 socialCost.lambda 默认 1.5。 */
export const LAMBDA0 = 1.5;
export const PHI_DIRECTED = 0.3;
export const PHI_TURN = 0.5;
export const OBLIGATION_THETA = 0.2;
/** 她说完话后这么久内对方接话，算轮到她（conversation turn）。 */
export const TURN_WINDOW = 600_000;

// ── 节律（论文 §6、ADR-195）：行动间隔由强度量 API_peak 决定 Δt = Δt_min + (Δt_max − Δt_min)·e^(−API_peak/κ_t)──
/** patrol 档：2 月 utils/time.ts。压力高时几秒一次，安静时拉长到 5 分钟；需求变了节奏跟着变。 */
export const RHYTHM = { min: 1_000, max: 300_000, kappa: 1 } as const;

/**
 * 发言调用连续失败 n 次后，节律唤醒至少等 min(上限, 起点·2^(n−1))（外部服务出错时的退避；
 * 被点名照常叫醒，一条消息至多一次调用）。工程参数，不是行为参数。
 */
export const FAILURE_BACKOFF = { first: 30_000, max: 30 * 60_000 } as const;

/** 唤醒分数 = logistic(NSV / τ)：NSV > 0 ⇔ 分数 > 0.5，正好是论文的沉默公理（Axiom V）。 */
export const WAKE_TEMPERATURE = 0.1;

// ── 反应感知（研究员 2026-11-11：确定性地从她行动之后的事件折叠出带类型的反应）──
/** 她说完话后等这么久看有没有人接：群 10 分钟（与 TURN_WINDOW 一致），私聊 1 天。手设。 */
export const RECEPTION_WINDOW: Record<ChatType, number> = { private: D, group: 10 * 60_000 };
/**
 * 被冷落、被拒绝时回避增加多少（ADR-217 的 A：cooling_down 1、fed_up 0.8，这里按反应类型取）。cold 是她的话上被点了
 * 负面表情（👎、🤡、💩……）：一次轻的拒绝，和被冷落一样重。手设。
 */
export const AVERSION_GAIN = { ignored: 0.5, rejected: 1, cold: 0.5 } as const;
/** 回避的时间常数（ADR-217：群 2 小时、私聊 8 小时）。对方来找她不清零。 */
export const AVERSION_TAU: Record<ChatType, number> = { private: 8 * H, group: 2 * H };
/**
 * 离开的机会成本（只对改变成员身份的动作收）：C_exit = invest·tanh(I/κ) + wait/(1 + n)。
 * I：她在这里赢得的回应（replied 反应，按亲疏分数的半衰期消退）加上这里开着的承诺——走了就都没了
 * （投资模型，Le & Agnew 2003）；n：这里已观测到的反应数，证据越薄等待越值（不可逆决策，Dixit & Pindyck 1994）。
 * 权重手设，落在性质 L1–L3 划定的区间里（test/pressure-properties.test.ts：有投入时 C_exit ∈ (0.1, 0.5)）。
 */
export const EXIT = { invest: 0.3, kappa: 3, wait: 0.3, halfLife: CLOSENESS_HALF_LIFE } as const;
/**
 * 睡着时行动的代价：权重 × 睡眠深度（sleep.ts，刚睡着为 1、快醒时为 0），对所有动作收。
 * 手设，落在性质划定的区间里（test/sleep.test.ts）：夜里一条私聊叫不醒她，快醒的那一小时里能。
 */
export const SLEEP_COST = 30;
/** 对让她回避的目标，接近类动作的额外代价权重（乘以动作不缓解回避的程度）。手设。 */
export const AVERSION_COST = 1;

// ── 线程（论文 Def P4）：只从环境确定性地推出——别人对她说的话停在那里、她没接 ──
/** 权重（论文 w(major)=2、w(minor)=0.5）：私聊里对方的话算 major，群里点名她算 minor。 */
export const THREAD_WEIGHT: Record<ChatType, number> = { private: 2, group: 0.5 };
/** 超线性增长 w·((1+age/天)^β − 1)，β = 1.5（论文 β_t）。 */
export const THREAD_BETA = 1.5;
/** 7 天还没接就过期，不再增长（ADR-206/258：线程有寿命，有类型的结局）。 */
export const THREAD_LIFETIME = 7 * D;

// ── 她自己的承诺与打算（论文 Remark prospect-separation；2 月 p-prospect.ts、observer note_promise/intend）──
/** 承诺算 major（2 月 note_promise 固定 weight major；论文 w(major) = 2）。 */
export const PROSPECT_WEIGHT = 2;
/**
 * P_prospect = w·σ(k·(x − ½))，x = 1 − remaining/L：L 是"到时候了"的窗（从窗口起点到约定时间）。
 * 2 月写成 σ(k·(1 − remaining/horizon))，刚答应时 σ(0) = 0.5，一答应就有一半压力（已知缺陷）；
 * 这里减去 ½，窗口起点只有 σ(−2.5) ≈ 0.08，约定时间 σ(2.5) ≈ 0.92，之后在宽限期里线性消退到 0
 * （2 月过了截止时间一直是最高值，没有结局）。k 取 2 月的 5。
 */
export const PROSPECT_K = 5;
/** 窗最短 15 分钟。 */
export const PROSPECT_MIN_LEAD = 15 * 60_000;
/**
 * 想过、决定先不：压力乘 1 − e^{−Δ/(r·L)} 重新长起（研究员 2026-11-11 的通用规则：考虑过也消耗压力）。
 * r = ½：一天的窗里大约两三小时再想一次。手设，闭环里看调用次数。
 */
export const PROSPECT_REGROW = 0.5;
/** 过了约定时间还这么久没做，就过期（L 夹在 [6 小时, 2 天]）。手设。 */
export const PROSPECT_GRACE = { min: 6 * H, max: 2 * D } as const;
/** 说了钟点的事到点时，"闹钟"在这么久之内没机会响（她正在别处想事）就不再响（memory.ts ringing）。手设。 */
export const PROSPECT_ALARM = 10 * 60_000;
/** 没说时间的打算没有截止压力，留在记忆里这么久（与线程寿命一致）。 */
export const UNDATED_LIFETIME = THREAD_LIFETIME;
/** 每个会话最多记这么多件没了结的事；多了最早的那件过期。了结的只留最近几件。手设。 */
export const OPEN_COMMITMENTS = 5;
export const CLOSED_COMMITMENTS = 5;

// ── 她自己的事（2 月 threads.mod；absorb/omp-report.md §2-1）──
/**
 * 每个会话最多跟着这么多件没了结的事；多了最久没动过的那件放下（2 月靠压力排序和 15 条上限压着，噪声大）。
 * 只放进提示词最近动过的 TOPICS_SHOWN 件，每件一行（不挤占聊天记录）。手设。
 */
export const OPEN_TOPICS = 8;
export const TOPICS_SHOWN = 3;
/** 这么久没开头、没推进的事不再放进提示词（只在渲染时不显示，不写"过期"事件；再推进一次就回来）。手设。 */
export const TOPIC_QUIET = 14 * D;
/** 提示词里一件事的标题、上一次进展最多这么多字（一行写得下）。 */
export const TOPIC_TITLE_CHARS = 40;
export const TOPIC_BEAT_CHARS = 60;

// ── 事实记忆（论文 §5 retrievability；2 月 relationships remember / constants.ts）──
/** 每个人（或每个群）最多记 20 件事，超出淘汰可检索性最低的（2 月 CONTACT_FACTS_LIMIT）。 */
export const FACTS_PER_SUBJECT = 20;
/** 初始稳定性（天），2 月 general 类型 S₀ = 14（不再让模型选类型）。 */
export const FACT_STABILITY = 14;
/** 重复记住同一件事：稳定性 ×1.2（2 月 STABILITY_REINFORCE_FACTOR）。 */
export const FACT_REINFORCE = 1.2;
/** 可检索性 R = (1 + Δt/(9S))^d，d = −0.5（2 月 utils/math retrievability，FACT_DECAY_D）。 */
export const FACT_DECAY_D = -0.5;
/** 一个人放进提示词的事（2 月 MAX_INJECTED_FACTS = 7；群里每人更少）。 */
export const FACTS_SHOWN = { private: 7, group: 3 } as const;
/** 群里最多为最近说话的几个人放事实。 */
export const PEOPLE_SHOWN = 5;
export const FACT_MAX_CHARS = 200;

// ── 心情（affect.ts；2 月 observer feel 的两个阈值）──
/** 同方向、变化不超过这么多时不重新推满（2 月 MOOD_RESET_THRESHOLD，防自我强化）。 */
export const MOOD_RESET = 0.15;
/** 评价离常态不到这么多就不再归给那件事（2 月 0.3 以下记为 neutral）。手设。 */
export const MOOD_VISIBLE = 0.15;

// ── 日记（diary.ts；2 月 diary.mod.ts 的常量名写在括号里）──
export const DIARY = {
  /** 一条最长多少字（MAX_ENTRY_LENGTH）。 */
  maxChars: 200,
  /** 一个决定（或一次反思）里最多写几条（DIARY_CAP_PER_TURN）。 */
  perDecision: 2,
  /** feb 的显示：写下后多久不再放进提示词（ENTRY_TTL_S = 12000 秒）。 */
  ttl: 12_000_000,
  /** 存多久：reflect 的显示要用到几天前的条目。 */
  retention: 30 * 24 * H,
  /** 最多存多少条，超出删最旧的（MAX_ENTRIES）。 */
  kept: 50,
  /** reflect 写下前去重：和同一批受众看得见的某条两字片段 Jaccard 超过这个值就不写。 */
  duplicate: 0.4,
  /** 不针对谁的放几条（GLOBAL_INJECT_LIMIT）。 */
  global: 3,
  /** feb：关于此刻对象的放几条（TARGET_INJECT_LIMIT）。 */
  target: 1,
  /** 一共最多放几条（TOTAL_INJECT_LIMIT）。 */
  total: 5,
} as const;
/**
 * reflect 的显示：Generative Agents（Park et al. 2023 §4.1）的近因 + 重要性 + 相关性，等权相加。近因从写下时
 * 算起、不因显示而刷新（GA 按上次取用刷新，反复显示的条目就永不变旧，是反刍的路子，ADR-95/102）。
 * importance：顺手写的条目没有分，按中间值算。target：关于此刻对象的最多几条（2 月 ADR-102 的 1 条没测过，
 * 会挤掉群里写下的那条；为什么是 2 见 eval-artifacts/scenes/prereg-round7.md）。
 */
export const DIARY_RANK = { decayPerHour: 0.995, importance: 5, target: 2 } as const;
/** 内心独白回写（候选 feb-thought：2 月 ThoughtTimelineSource，ADR-117）：这个会话里多久之内、最近几条、每条几个字。 */
export const THOUGHT = { window: H / 6, shown: 3, chars: 120, kept: 30 } as const;
/** 行动回声（ADR-102 组件 1）：她在这个会话里这么久之内说过的话，最多几条、每条几个字。 */
export const ECHO = { lookback: H, max: 5, chars: 80 } as const;
/**
 * 反思（reflect）：她在一个会话里经历累计到 involved 就写一次（GA 按累计重要性触发、每天两三次），那里安静
 * quiet 之后写，累计到 burst 倍还没安静也写；带那段对话最近 lines 条。冲着她的消息和她的话记 1，群里没冲着她的
 * 记 ambient（GA 重要性量表上平常小事约 2、刻骨铭心约 8）。参数按反思频率挑，不按送达挑
 * （eval-artifacts/scenes/prereg-round6.md）。
 */
export const REFLECT = {
  quiet: 3 * 60_000,
  lines: 30,
  involved: 4,
  burst: 3,
  ambient: 0.25,
} as const;

// ── 她最近几次开口的结果（2 月 printPastResults、feedback-arc）──
export const OUTCOMES_SHOWN = 3;
/** 过期没做的承诺，这么久之内还记得提。手设。 */
export const EXPIRED_SHOWN = 2 * D;

// ── 她够得着的世界（reach.ts，A18/A08）──
/** 看过的群的预览这么快变旧（好奇心按 e^(−age/τ) 衰减）：一天之后就淡了。手设。 */
export const PLACE_FRESH = D;
/** 去看过、没加入之后，想去的念头重新长起的时间常数：几个小时后才会再想一次。手设。 */
export const PLACE_REGROW = 6 * H;
/**
 * 加入的机会成本（只对让她加入的动作收）：C_join = load·tanh(G/κ)，G 是她这一周里有人说话的群的个数。
 * 注意力是有限的，已经在的群越多，多一个群分走的越多（和离开的 C_exit 对称：离开丢掉投入，加入分走注意）。
 * load 取 C_exit 投入项的同一个量级（EXIT.invest）。手设，没测过。
 */
export const JOIN = { load: 0.3, kappa: 5, activeWithin: 7 * D } as const;
/**
 * 频道里看到的东西（P02、M03）：最多记 count 条、记 kept 之内的；shownWithin 之内的才摆在她面前（每次最多 shown 条）；
 * 想分享的劲头按 e^(−age/fresh) 变小（新闻隔半天就不新了）；每条截 chars 个字。手设。
 */
export const INFO = {
  count: 20,
  kept: 2 * D,
  shownWithin: D,
  shown: 3,
  fresh: 6 * H,
  chars: 160,
} as const;
