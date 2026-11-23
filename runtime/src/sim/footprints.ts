/**
 * 每个生产机制应该留下的 footprint（普查 census.ts 读这张表）。一项一个 footprint：在哪里看、怎么数、期望多少。
 * 新机制加进注册表之前先在这里写下自己的 footprint（candidate-process.md 的仿真关）；test/census.test.ts 查每个生产机制
 * 至少有一项。
 *
 * 量法（measure）：
 * - prompt：发言调用的提示词里有这段（正则），数占比（chat 限定群或私聊）；
 * - act：她做这个动作，数每天几次；
 * - wake：这一类叫醒（calls.jsonl 的 kind），数每天几次；
 * - dwell：对话里的 footprint（dwell.jsonl）：floor-wakes 是在对话里被没点名的消息叫醒的次数每天几次，passed-by 是
 *   对话走过她才结束的段占几成；
 * - in-bed：她选去睡（go_to_bed）之后、到作息的下一次醒来之前（bedtime.ts nextWake）的叫醒。unsought-group 是被群里
 *   没找她的话叫醒（kind 为 group-floor、group-follow）的次数；not-woken 是提示词里没写"被消息吵醒了"的次数：调用记着 asleep
 *   的运行只数被消息叫醒的；旧的运行分不清她当时睡没睡着，时段里按时钟格醒来的那次也算。
 *   睡着时只有找她的话能把她叫起来（睡眠代价按深度），叫起来时她知道自己是被吵醒的；
 * - waited：被一条消息叫醒的调用里，调用晚于记录里最后一条的占比（等对方说完才想）。
 * - readback：她在一个会话里写过想法（<inner>）、那段对话还在时，之后这个会话里的调用把它读回的占比
 *   （每次调用该有几条"想过："，最多 3 条，够了才算）。对话还在不在只从日志读，不调机制：群里是 dwell.jsonl 里
 *   盖住想法和这次调用的那段会话（起始往前让一轮 TURN_GAP，同一轮里先想后说）；私聊里是从想法那一次到这一次，
 *   每两次调用之间新来的消息都隔不到 SEGMENT_GAP_MS、这次调用离最后一条也不到（保守：拿不准就不进分母）。
 *   开着的、窗口结束时还没结束的会话不进分母。
 * - carried：她在群里想过、写下后 CARRY_FOR 之内，写下时在那个群里的人（那个群最近 RECENT 条消息的发言人，
 *   从消息日志读）私聊里的调用，"在群里想过："的行数够了的占比。每个群只算最近 THOUGHT.shown 条想法（inner.ts
 *   每个会话只留这么多），每次调用最多这么多条。
 * - audience：卡片上每一行"想过："按来源重算受众规则，违反的行数。不带"在群里"的，要有这个会话里更早的一条
 *   想法字面对得上；带"在群里"的，要在私聊里，有一条群里的想法字面对得上、离现在不到 CARRY_FOR，私聊的对方
 *   写下时在那个群里。替身想的都是"……"，普查里只查得出标签和规则；线上 fold 的想法是真的，逐字查。
 *   想法写下的那一刻比调用晚（回放里同时，线上晚几秒到一分钟），那一刻谁在场拿不准：carried 只算调用时和
 *   WRITE_SLACK 之后都在的人（保守），audience 算两头任一时在的人（宽）。
 * - repeat-carried：卡片上带着"在群里想过："的调用里，她这一轮的话（说的、想的）和带来的某一行有 chars 字以上
 *   连着一样的占比（复读；2 月第 3 代把独白带到所有会话时逐字重复 23%，emotion/prereg-diary.md）。stub 说的是占位
 *   文字，只有真模型的读数有意义。
 * - latency、coverage、away、group-turns：时机，口径同 eval-artifacts/life/readout.py 与 lambda0-scan 的 scan_lib，
 *   读普查从数据集里给的"找她的消息"（directed，按回放的样子：她的旧话删掉后，回她的话除非点名不再算找她；窗口最后
 *   2 小时的不算，免得截断）和窗口里有人说话的群（groups）。她的可见动作是发消息、贴纸、表情、退群，时刻取调用时刻。
 *   - latency：醒着时（作息）找她的消息到她在那个会话里下一个可见动作。mid 是落在 1–15 分钟的份额（没回的算在
 *     分母里）。
 *   - reply-latency：她真回了的那些的延迟，和真人同一个口径（switching-scan/human-latency.json）：群里她引用
 *     别人的一条消息回话，从那条消息到她这次调用，只算 24 小时内的；读数是分位（分钟）。引用的是回应模型现编的
 *     消息（数据集里没有）时不算。
 *   - coverage：找她的消息（不分醒睡）minutes 分钟内（不给是 10）有可见动作的份额；chat 只看群（会话 id 以
 *     telegram:- 开头）或私聊。
 *   - away：她的长离开每天几次：醒着时相邻两个可见动作隔了 10 分钟以上、同一天、中间没睡，长度 ≥ minutes。
 *   - group-turns：她在每个群每天几轮（发消息或贴纸，隔 90 秒以上算新的一轮），各群的平均。
 *   - group-band：她在这个群的轮数不超过这个群窗口里说得最多的四分之一人（至少 4 人说话的群）的 p90 的群的比例。
 * 期望（expect）只写设计定下的；"体检待补"的只要求出现（min 大于 0）。来源：eval-artifacts/footprint/prompts.mjs
 * 的签名（2026-11-12 体检）。
 */

import { nextWake } from "../mechanisms/pressure/bedtime.js";
import { DIARY, THOUGHT, TURN_GAP } from "../mechanisms/pressure/params.js";
import { isAsleep } from "../mechanisms/pressure/sleep.js";
import { SEGMENT_GAP_MS } from "../mind/state.js";
import { localDay } from "../mind/when.js";

export type Measure =
  | { type: "prompt"; where: "user" | "system"; pattern: string; chat?: "group" | "private" }
  | { type: "act"; kind: string; chat?: "group" | "private" }
  | { type: "wake"; kind: string }
  | { type: "dwell"; what: "floor-wakes" | "passed-by" }
  | { type: "in-bed"; what: "unsought-group" | "not-woken" }
  | { type: "waited" }
  | { type: "readback"; chat?: "group" | "private" }
  | { type: "carried" }
  | { type: "audience" }
  | { type: "repeat-carried"; chars: number }
  | { type: "latency"; what: "mid" }
  | { type: "reply-latency"; quantile: number }
  | { type: "coverage"; chat?: "group" | "private"; minutes?: number }
  | { type: "away"; minutes: number }
  | { type: "group-turns" }
  | { type: "group-band" }
  /** 她发出去的每条文字（说的话、语音）的字数，取中位。 */
  | { type: "line-chars"; chat?: "group" | "private" }
  /** 群里叫醒她的那条引用回复了数据里别人的一句：那一句作为记录里带编号的一行在提示词里的占比。 */
  | { type: "quoted" };

export interface Footprint {
  /** 注册表里的机制名、压力场的一格（pressure.<格>），或发言层（speech）。 */
  mechanism: string;
  footprint: string;
  measure: Measure;
  /** 占比（0–1）或每天次数，看量法；只报的项是参照（例如活跃档）。 */
  expect: { min?: number; max?: number };
  source: "设计" | "体检待补";
  /** 只报，不判在不在预期内。 */
  reportOnly?: true;
}

const present = { min: 0.001 } as const;

export const FOOTPRINTS: readonly Footprint[] = [
  {
    mechanism: "pressure.body",
    footprint: "群里的提示词写着她住在平行世界",
    measure: { type: "prompt", where: "user", pattern: "我住在平行世界", chat: "group" },
    expect: { min: 0.95 },
    source: "设计",
  },
  {
    mechanism: "pressure.life",
    footprint: "她刚做完一件事或说自己的精力",
    measure: {
      type: "prompt",
      where: "user",
      pattern:
        "我刚(洗漱完|吃完饭|吃完夜宵|洗完澡|打完游戏|看完一集剧)|我这会儿(有点累|精神挺好|挺想找人聊聊天|人有点犯懒)",
    },
    expect: present,
    source: "体检待补",
  },
  // 时机对着真人（PLAN 待办 4；真人读数 switching-scan/human-latency.json、human-absence-sensitivity.txt）：
  // 比真人稍快一点，判据是真人的 0.5–2 倍，不拟合中位数（docs/research/her-life.md）。
  {
    mechanism: "pressure.life",
    footprint: "醒着时被找，回应落在 1–15 分钟的份额（真人 0.323 的 0.5–2 倍）",
    measure: { type: "latency", what: "mid" },
    expect: { min: 0.16, max: 0.65 },
    source: "设计",
  },
  {
    mechanism: "pressure.life",
    // 一个窗口里只有 30–50 条：样本够之前只报（2 月 0、A、B 一起读）。
    footprint: "她真回了的话（群里引用回话）延迟的 p90 不超过真人的 14.65 分钟",
    measure: { type: "reply-latency", quantile: 0.9 },
    expect: { max: 14.65 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.life",
    footprint: "离开 30 分钟以上（每天；真人 2.75 的 0.5–2 倍）",
    measure: { type: "away", minutes: 30 },
    expect: { min: 1.38, max: 5.5 },
    source: "设计",
  },
  {
    mechanism: "pressure.life",
    footprint: "离开 60 分钟以上（每天；真人 1.35 的 0.5–2 倍）",
    measure: { type: "away", minutes: 60 },
    expect: { min: 0.68, max: 2.7 },
    source: "设计",
  },
  {
    mechanism: "pressure.sleep",
    footprint: "去睡之后到作息醒来之前，群里没找她的话不叫醒她",
    measure: { type: "in-bed", what: "unsought-group" },
    expect: { max: 0 },
    source: "设计",
  },
  {
    mechanism: "pressure.sleep",
    footprint: "去睡之后被叫起来时，提示词写着她是被吵醒的",
    measure: { type: "in-bed", what: "not-woken" },
    expect: { max: 0 },
    source: "设计",
  },
  {
    mechanism: "pressure.sleep",
    footprint: "夜里能去睡（SDK 里的 go_to_bed）",
    measure: { type: "prompt", where: "system", pattern: "go_to_bed: " },
    expect: present,
    source: "设计",
  },
  {
    mechanism: "pressure.sleep",
    footprint: "她说去睡（每天）",
    measure: { type: "act", kind: "bed" },
    expect: { min: 0.5, max: 2 },
    source: "设计",
  },
  {
    mechanism: "pressure.affect",
    footprint: "心情那一行",
    measure: { type: "prompt", where: "user", pattern: "^· 心情：" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "pressure.diary",
    footprint: "心里还记着的日记行",
    measure: { type: "prompt", where: "user", pattern: "心里还记着" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "pressure.thought",
    footprint: "想过的读回下一轮",
    measure: { type: "prompt", where: "user", pattern: "想过：" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "pressure.thought",
    footprint: "这段对话里她写过的想法，之后每一轮都读回（群）",
    measure: { type: "readback", chat: "group" },
    expect: { min: 0.95 },
    source: "设计",
  },
  {
    mechanism: "pressure.thought",
    footprint: "这段对话里她写过的想法，之后每一轮都读回（私聊）",
    measure: { type: "readback", chat: "private" },
    expect: { min: 0.95 },
    source: "设计",
  },
  {
    mechanism: "pressure.thought",
    footprint: "卡片上的想法没有违反受众规则的（行数）",
    measure: { type: "audience" },
    expect: { max: 0 },
    source: "设计",
  },
  {
    mechanism: "pressure.thought",
    footprint: "群里想过的，带到写下时在场的人的私聊",
    measure: { type: "carried" },
    expect: { min: 0.95 },
    source: "设计",
  },
  {
    // 只报：stub 说的是占位文字，只有真模型的读数有意义（第 3 片 1/27，预注册上限 10%）。
    mechanism: "pressure.thought",
    footprint: "复读：私聊里她的话和带来的想法连着 8 字以上一样",
    measure: { type: "repeat-carried", chars: 8 },
    expect: { max: 0.1 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.memory",
    footprint: "她最近几次在这里开口的结果",
    measure: { type: "prompt", where: "user", pattern: "我最近几次在这里开口", chat: "group" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "pressure.people",
    footprint: "她自己说过的事",
    measure: { type: "prompt", where: "user", pattern: "我自己说过的" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "pressure.floor",
    footprint: "在对话里被没点名的消息叫醒（每天）",
    measure: { type: "dwell", what: "floor-wakes" },
    expect: present,
    source: "设计",
  },
  {
    mechanism: "pressure.floor",
    footprint: "对话走过她才结束的段的占比",
    measure: { type: "dwell", what: "passed-by" },
    expect: { max: 0.5 },
    source: "设计",
  },
  {
    mechanism: "pressure-production",
    footprint: "群里没人点她时的那一行",
    measure: { type: "prompt", where: "user", pattern: "这会儿没人点你", chat: "group" },
    expect: present,
    source: "设计",
  },
  {
    mechanism: "pressure-production",
    // 0.762 是到北极星的距离，不是候选的门槛：生产自己也没到。候选的门槛是不比同一窗口的 production 低 0.05 以上。
    footprint: "找她的消息 10 分钟内有回应（不分醒睡；ranges.json 的下限，到北极星的距离）",
    measure: { type: "coverage" },
    expect: { min: 0.762 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure-production",
    // 候选的门槛读这一项（主会话 2026-11-13）：时限取真人回复延迟的 p90 14.65 分钟，取整为 15，是真人数据里的数，
    // 不按我们的结果挑；10 分钟的那条切在 1–15 分钟的目标中段里。门槛是不比同一窗口的 production 低 0.05 以上，
    // 是两次运行之间的比较，这里只报。
    footprint: "找她的消息 15 分钟内有回应（不分醒睡；真人回复 p90 的时限）",
    measure: { type: "coverage", minutes: 15 },
    expect: {},
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure-production",
    footprint: "她在每个群每天的轮数不超过这个群说得最多的四分之一人的 p90（各群自己的带，北极星）",
    measure: { type: "group-band" },
    expect: { min: 1 },
    source: "设计",
  },
  {
    mechanism: "pressure-production",
    footprint: "节律叫醒（每天，群）",
    measure: { type: "wake", kind: "group-tick" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "pressure-production",
    footprint: "被点名叫醒（每天，群）",
    measure: { type: "wake", kind: "group-triggered" },
    expect: present,
    source: "体检待补",
  },
  {
    // 按人读回避本身（冲着她的消息上没有一条读会话的回避、有几条是按人读才值得回）普查算不出：
    // 在线上 Journal 上用 pnpm addressed 重查（src/sim/addressed.ts）。
    mechanism: "pressure.relation",
    footprint: "群里找她的消息 10 分钟内有回应",
    measure: { type: "coverage", chat: "group" },
    expect: present,
    source: "体检待补",
  },
  {
    // eval-artifacts/context-assembly/：被引用的那句已经在 30 条以前时带回记录。
    // 只数数据里别人的话（她自己的话、回应模型现编的回复不在 messages 里）。
    mechanism: "pressure.context",
    footprint: "群里叫醒她的那条引用的那一句，在记录里看得见",
    measure: { type: "quoted" },
    expect: { min: 0.99 },
    source: "设计",
  },
  {
    mechanism: "missed",
    footprint: "别的聊天里来了消息",
    measure: { type: "prompt", where: "user", pattern: "别的聊天里来了" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "familiar",
    footprint: "在场的人写着是朋友、认识多久",
    measure: { type: "prompt", where: "user", pattern: "这个群里的朋友|和我在同一个群里的朋友" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "palette",
    footprint: "平时的几种回法",
    measure: { type: "prompt", where: "system", pattern: "你平时(在群里|私聊时)的几种回法" },
    expect: { min: 0.95 },
    source: "设计",
  },
  {
    mechanism: "sticker-bag",
    footprint: "手头可用的贴纸视觉清单",
    measure: { type: "prompt", where: "system", pattern: "手头贴纸有：" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.attachment",
    footprint: "长期牵挂与深疤只调意愿强度，不另写提示词行",
    measure: { type: "prompt", where: "user", pattern: ".*" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  // PLAN 第 44 件（docs/research/desire-2026-11-13.md）：第六遍普查里每天摆出约 10 件、说出约 3 次。
  {
    mechanism: "pressure.desire",
    footprint: "群里没人找她时，这一次是什么叫醒她写在卡片上（旁观者那一句不再出现）",
    measure: { type: "prompt", where: "user", pattern: "没人点名；大家在自己聊。", chat: "group" },
    expect: present,
    source: "设计",
  },
  {
    mechanism: "pressure.desire",
    footprint: "她手里有一件频道里刚看到、和这里在聊的对得上的东西（有频道新帖的数据才有）",
    measure: { type: "prompt", where: "user", pattern: "刚在频道看到一条内容|频道里刚发了一条" },
    expect: { min: 0 },
    source: "体检待补",
    reportOnly: true,
  },
  {
    mechanism: "pressure.reach",
    footprint: "能找群或把频道帖子转给熟人（有私聊/找群机会时出现）",
    measure: { type: "prompt", where: "system", pattern: "find_chats:|forward:" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.fairness",
    footprint: "初次私聊的防备检查能力（开启初次私聊时出现）",
    measure: { type: "prompt", where: "system", pattern: "check_dm:|plan_group_dm:" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.topics",
    footprint: "能记着和推进自己跟进的事（SDK 里的 open_topic）",
    measure: { type: "prompt", where: "system", pattern: "open_topic:" },
    expect: present,
    source: "设计",
  },
  {
    mechanism: "pressure.recallTools",
    footprint: "能翻查更早记忆与记下自己的事（SDK 里的 recall）",
    measure: { type: "prompt", where: "system", pattern: "recall:" },
    expect: present,
    source: "设计",
  },
  {
    mechanism: "pressure.feedback",
    footprint: "接住或冷落的正向回流只进驱动与心情，不另写提示词行",
    measure: { type: "prompt", where: "user", pattern: ".*" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.echo",
    footprint: "最近在想的事或别人提过的话题自然回响",
    measure: { type: "prompt", where: "user", pattern: ".*" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  {
    mechanism: "pressure.topic",
    footprint: "群里话题接茬时的拉动（只进压力场，不另写提示词行）",
    measure: { type: "prompt", where: "user", pattern: ".*" },
    expect: { min: 0 },
    source: "设计",
    reportOnly: true,
  },
  // PLAN 第 55 件第 4 项（eval-artifacts/scene-facts/）：有 chat.described 的数据才有群那一行。
  {
    mechanism: "scene-facts",
    footprint: "群卡片里写着这个群有多少人、群主是谁（外壳查过群的样子才有）",
    measure: { type: "prompt", where: "user", pattern: "这个群：", chat: "group" },
    expect: { min: 0 },
    source: "体检待补",
    reportOnly: true,
  },
  {
    mechanism: "room-voice",
    footprint: "这个群的人平时怎么打字（群聊够了冷启动门槛才有）",
    measure: {
      type: "prompt",
      where: "system",
      pattern: "这个群的人平时怎么打字|群友之间的几段接话",
    },
    // real-v1 开发集的群聊时刻 81/94 有（docs/adr/282-speech-style-and-room-voice.md）；私聊和小群没有。
    expect: present,
    source: "设计",
  },
  {
    mechanism: "typing-patience",
    footprint: "被消息叫醒时等对方说完才想",
    measure: { type: "waited" },
    expect: { min: 0.9 },
    source: "设计",
  },
  {
    mechanism: "language",
    footprint: "谁用什么语言跟她说话",
    measure: {
      type: "prompt",
      where: "user",
      pattern: "用[^\\s，。；]{1,8}跟你说话|在说[^\\s，。；]{1,8}[。；]",
    },
    expect: { min: 0.5 },
    source: "体检待补",
  },
  {
    mechanism: "presence",
    footprint: "记录最后连着几条都是她的",
    measure: { type: "prompt", where: "user", pattern: "聊天记录最后连着 \\d+ 条都是你发的" },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "failures",
    footprint: "她刚才想做的事没做成",
    measure: {
      type: "prompt",
      where: "user",
      pattern:
        "我刚才想[^\\n]*没(发出去|点上|翻成|标上|退成|加进来|转过来|找成|改成)|不知道(发出去|点上)没有",
    },
    expect: { min: 0 },
    source: "体检待补",
  },
  {
    mechanism: "errands",
    footprint: "能查一下（SDK 里的 look_up）",
    measure: { type: "prompt", where: "system", pattern: "look_up: " },
    expect: { min: 0.9 },
    source: "体检待补",
  },
  {
    mechanism: "voice",
    footprint: "能发语音（SDK 里的 voice）",
    measure: { type: "prompt", where: "system", pattern: "voice: " },
    expect: present,
    source: "体检待补",
  },
  {
    mechanism: "expression",
    footprint: "能改消息或复读（SDK 里的 edit、repeat）",
    measure: { type: "prompt", where: "system", pattern: "  edit: |  repeat: " },
    expect: present,
    source: "体检待补",
  },
  {
    // 只报：长短不是标准，不真实的长篇大论才是（北极星）。参照是 2 月 B 各群发言量前 25% 的人，每人每条字数的
    // 中位取 p25–p75（6–14，p90 31，eval-artifacts/exec-mode/prereg-loop.md）。stub 发的是占位文字，只有线上读数有意义。
    mechanism: "speech",
    footprint: "群里每条字数（中位），对活跃档",
    measure: { type: "line-chars", chat: "group" },
    expect: { min: 6, max: 14 },
    source: "设计",
    reportOnly: true,
  },
];

/** 普查要读的一次运行（will-replay 的输出目录里那几份）。 */
export interface RunFiles {
  days: number;
  calls: ReadonlyArray<{
    scope: string;
    chatType: string;
    at: number;
    kind: string;
    trigger: string | null;
    lastMessageAt?: number | null;
    asleep?: boolean;
    acts: ReadonlyArray<{
      kind: string;
      replyTo?: string | null;
      text?: unknown;
      thought?: unknown;
    }>;
  }>;
  prompts: ReadonlyArray<{
    scope: string;
    at: number;
    system: string;
    user: string;
    tools?: ReadonlyArray<{
      function?: {
        name?: string;
        description?: string;
        parameters?: { properties?: { action?: { enum?: readonly string[] } } };
      };
    }>;
  }>;
  dwell: ReadonlyArray<{
    t: "inside" | "end";
    scope: string;
    id?: string;
    why?: string;
    /** end：这段会话的起止。 */
    from?: number;
    at?: number;
  }>;
  /** 数据集里找她的消息（时机的几项读它；普查给，没有时这几项无样本）。 */
  directed?: ReadonlyArray<{ scope: string; at: number }>;
  /** 窗口里有人说话的群。 */
  groups?: readonly string[];
  /**
   * 数据集里别人的消息（到窗口结束为止）：她在群里引用回话时按编号找它的时刻；carried、audience 从这里读谁在场。
   */
  messages?: ReadonlyArray<{ scope: string; id: string; at: number; from: string }>;
  /** 回应模型现编的消息（replies.jsonl）：只用来算谁在场，引用回话的时刻不读它。 */
  replies?: ReadonlyArray<{ scope: string; at: number; from: string }>;
}

const UNSOUGHT_GROUP = new Set(["group-floor", "group-follow"]);

type MeasureOf<T extends Measure["type"]> = Extract<Measure, { type: T }>;

/** 一项 footprint 在一次运行里的读数（占比或每天次数）；分母为 0 时是 null。 */
export function measure(m: Measure, run: RunFiles): number | null {
  switch (m.type) {
    case "prompt":
      return promptShare(m, run);
    case "act":
      return (
        run.calls
          .filter((c) => inChat(m.chat, c))
          .reduce((a, c) => a + c.acts.filter((x) => x.kind === m.kind).length, 0) / run.days
      );
    case "wake":
      return run.calls.filter((c) => c.kind === m.kind).length / run.days;
    case "dwell":
      return dwellMeasure(m, run);
    case "waited": {
      const woken = run.calls.filter((c) => c.trigger !== null && c.lastMessageAt != null);
      return woken.length === 0
        ? null
        : woken.filter((c) => c.at > (c.lastMessageAt as number)).length / woken.length;
    }
    case "readback":
      return readback(run, m.chat);
    case "carried":
      return carried(run);
    case "audience":
      return audience(run);
    case "repeat-carried":
      return repeatCarried(run, m.chars);
    case "line-chars":
      return lineChars(m, run);
    case "quoted":
      return quotedShare(run);
    case "latency": {
      const awake = (run.directed ?? []).filter((e) => !isAsleep(e.at));
      if (awake.length === 0) return null;
      const lat = latencies(run, awake);
      return lat.filter((x) => x >= MIN && x <= 15 * MIN).length / lat.length;
    }
    case "reply-latency":
      return replyLatency(m, run);
    case "coverage": {
      const all = (run.directed ?? []).filter(
        (e) => !m.chat || e.scope.startsWith("telegram:-") === (m.chat === "group"),
      );
      if (all.length === 0) return null;
      return latencies(run, all).filter((x) => x <= (m.minutes ?? 10) * MIN).length / all.length;
    }
    case "away":
      return awayPerDay(m, run);
    case "group-turns": {
      const groups = run.groups ?? [];
      if (groups.length === 0) return null;
      const perGroup = groups.map(
        (g) => turnCount(run.calls.filter((c) => c.scope === g)) / run.days,
      );
      return perGroup.reduce((s, x) => s + x, 0) / groups.length;
    }
    case "group-band":
      return groupBand(run);
    case "in-bed":
      return inBed(m, run);
  }
}

/** 调用或提示词在不在这一类会话里：有 chatType 看它，没有就看提示词开头是不是群。 */
function inChat(chat: string | undefined, c: { chatType?: string; user?: string }): boolean {
  if (!chat) return true;
  if (c.chatType) return c.chatType === chat;
  return /^[─ ]*Telegram 群/.test(c.user ?? "") === (chat === "group");
}

function systemWithTools(p: RunFiles["prompts"][number]): string {
  if (!p.tools || p.tools.length === 0) return p.system;
  const lines = p.tools.flatMap((t) => {
    const fn = t.function;
    if (!fn?.name) return [];
    const desc = fn.description ?? "";
    const actions = fn.parameters?.properties?.action?.enum ?? [];
    return [`  ${fn.name}: ${desc}`, ...actions.map((a) => `  ${a}: `)];
  });
  return `${p.system}\n${lines.join("\n")}`;
}

function promptShare(m: MeasureOf<"prompt">, run: RunFiles): number | null {
  const re = new RegExp(m.pattern, "m");
  const rows = run.prompts.filter((p) => inChat(m.chat, p));
  return rows.length === 0
    ? null
    : rows.filter((p) => re.test(m.where === "system" ? systemWithTools(p) : p.user)).length /
        rows.length;
}

function dwellMeasure(m: MeasureOf<"dwell">, run: RunFiles): number | null {
  if (m.what === "passed-by") {
    const ends = run.dwell.filter((d) => d.t === "end");
    return ends.length === 0
      ? null
      : ends.filter((d) => d.why === "passed-by").length / ends.length;
  }
  const inside = new Set(
    run.dwell.filter((d) => d.t === "inside").map((d) => `${d.scope}/${d.id}`),
  );
  return run.calls.filter((c) => inside.has(`${c.scope}/${c.trigger}`)).length / run.days;
}

/** 她发出去的每条文字（说的话、语音）的字数的中位。 */
function lineChars(m: MeasureOf<"line-chars">, run: RunFiles): number | null {
  const lengths = run.calls
    .filter((c) => inChat(m.chat, c))
    .flatMap((c) => c.acts)
    .flatMap((a) =>
      (a.kind === "send" || a.kind === "voice") && typeof a.text === "string"
        ? [[...a.text].length]
        : [],
    )
    .sort((x, y) => x - y);
  if (lengths.length === 0) return null;
  const mid = lengths.length >> 1;
  return lengths.length % 2
    ? (lengths[mid] as number)
    : ((lengths[mid - 1] as number) + (lengths[mid] as number)) / 2;
}

/** 群里叫醒她的那条引用回复的那一句，有没有作为带编号的一行出现在提示词里。 */
function quotedShare(run: RunFiles): number | null {
  const known = new Set((run.messages ?? []).map((x) => `${x.scope}|${x.id}`));
  let asked = 0;
  let seen = 0;
  for (const p of run.prompts) {
    if (!inChat("group", p)) continue;
    const quoted = quotedByTrigger(p.user);
    if (!quoted || !known.has(`${p.scope}|${quoted}`)) continue;
    asked++;
    if (p.user.includes(`[${quoted}] <`)) seen++;
  }
  return asked === 0 ? null : seen / asked;
}

/** 提示词里叫醒她的那一行引用回复的编号。 */
function quotedByTrigger(user: string): string | undefined {
  const trigger = /\[([^\]\n]+)\] 之后，轮到你了/.exec(user)?.[1];
  if (!trigger) return undefined;
  const line = user.split("\n").find((l) => l.includes(`[${trigger}] <`));
  return line ? /（回复 \[([^\]\n]+)\]）/.exec(line)?.[1] : undefined;
}

/** 群里她引用回话时，离那一句过了多久（分钟），取 quantile 分位。 */
function replyLatency(m: MeasureOf<"reply-latency">, run: RunFiles): number | null {
  const sentAt = new Map((run.messages ?? []).map((x) => [`${x.scope}/${x.id}`, x.at]));
  const delays = run.calls
    .filter((c) => c.chatType === "group")
    .flatMap((c) =>
      c.acts.flatMap((a) => {
        const t = a.replyTo ? sentAt.get(`${c.scope}/${a.replyTo}`) : undefined;
        return t !== undefined && c.at > t && c.at - t < DAY ? [c.at - t] : [];
      }),
    )
    .sort((a, b) => a - b);
  if (delays.length === 0) return null;
  return (delays[Math.floor(m.quantile * (delays.length - 1))] as number) / MIN;
}

/** 醒着、同一天里，两个可见动作之间隔了 minutes 以上、中间没睡的次数，每天。 */
function awayPerDay(m: MeasureOf<"away">, run: RunFiles): number | null {
  if (run.calls.length === 0) return null;
  const times = run.calls
    .filter((c) => c.acts.some((a) => VISIBLE.has(a.kind)) && !isAsleep(c.at))
    .map((c) => c.at)
    .sort((a, b) => a - b);
  let n = 0;
  for (let i = 1; i < times.length; i++) {
    const [a, b] = [times[i - 1] as number, times[i] as number];
    if (b - a < m.minutes * MIN || b - a <= BOUT_GAP || localDay(a) !== localDay(b)) continue;
    if (!sleptBetween(a, b)) n++;
  }
  return n / run.days;
}

/** 两个时刻之间（每 5 分钟看一次）有没有睡着过。 */
function sleptBetween(a: number, b: number): boolean {
  for (let t = a; t < b; t += 5 * MIN) if (isAsleep(t)) return true;
  return false;
}

/** 她的轮数：开口（发话或贴纸）的调用按时间排，隔 TURN_GAP 以上算新的一轮。 */
function turnCount(calls: readonly Call[]): number {
  const ts = calls
    .filter((c) => c.acts.some((a) => a.kind === "send" || a.kind === "sticker"))
    .map((c) => c.at)
    .sort((a, b) => a - b);
  return ts.filter((t, i) => i === 0 || t - (ts[i - 1] as number) > TURN_GAP).length;
}

/** 她在群里的轮数没超过这个群活跃前四分之一的人的 p90 的群的占比（人少于 4 个的群不算）。 */
function groupBand(run: RunFiles): number | null {
  const groups = run.groups ?? [];
  const msgs = run.messages ?? [];
  if (groups.length === 0 || msgs.length === 0) return null;
  const until = msgs.reduce((latest, x) => Math.max(latest, x.at), -Infinity);
  const from = until - run.days * DAY;
  const inBand = groups.flatMap((g) => {
    const p90 = activeP90(msgs.filter((x) => x.scope === g && x.at >= from));
    if (p90 === null) return [];
    const hers = turnCount(run.calls.filter((c) => c.scope === g && c.at >= from && c.at <= until));
    return [hers <= p90 ? 1 : 0];
  });
  return inBand.length === 0 ? null : inBand.reduce((s, x) => s + x, 0) / inBand.length;
}

/** 一个群里每人的轮数，发言前四分之一的人的 p90；少于 4 个人时是 null。 */
function activeP90(msgs: NonNullable<RunFiles["messages"]>): number | null {
  const counts = new Map<string, number>();
  let last: { from: string; at: number } | null = null;
  for (const x of [...msgs].sort((a, b) => a.at - b.at)) {
    if (!last || last.from !== x.from || x.at - last.at > TURN_GAP)
      counts.set(x.from, (counts.get(x.from) ?? 0) + 1);
    last = x;
  }
  const top = [...counts.values()].sort((a, b) => b - a);
  if (top.length < 4) return null;
  const quarter = top.slice(0, Math.ceil(top.length / 4)).sort((a, b) => a - b);
  return quarter[Math.min(quarter.length - 1, Math.floor(0.9 * (quarter.length - 1) + 0.5))] ?? 0;
}

/**
 * 她睡着时的调用：群里没人找她叫醒的次数，或不是被消息吵醒的次数。调用记着 asleep 时读它，
 * 旧的运行没有就按她说去睡到下次醒之间算。
 */
function inBed(m: MeasureOf<"in-bed">, run: RunFiles): number {
  const hasAsleep = run.calls.some((c) => c.asleep !== undefined);
  let asleep: Call[];
  if (hasAsleep) {
    asleep = run.calls.filter((c) => c.asleep === true);
  } else {
    const beds = run.calls.filter((c) => c.acts.some((a) => a.kind === "bed")).map((c) => c.at);
    asleep = run.calls.filter((c) => beds.some((b) => c.at > b && c.at < nextWake(b)));
  }
  if (m.what === "unsought-group") return asleep.filter((c) => UNSOUGHT_GROUP.has(c.kind)).length;
  const prompt = new Map(run.prompts.map((p) => [`${p.scope}@${p.at}`, p.user]));
  // 记着 asleep 的运行只数有消息叫醒的调用；旧的运行连时钟格叫醒的也数。
  return asleep.filter(
    (c) =>
      (!hasAsleep || c.trigger !== null) &&
      !prompt.get(`${c.scope}@${c.at}`)?.includes("被消息吵醒了"),
  ).length;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** 她看得见的动作（别人看得到她在不在）。 */
const VISIBLE = new Set(["send", "sticker", "react", "leave-chat"]);
/** 隔这么久以上才算离开（口径同 switching-scan 的 absence_ref）。 */
const BOUT_GAP = 10 * MIN;

/** 每条找她的消息到她在那个会话里下一个可见动作（毫秒；没有就是无穷大）。 */
function latencies(run: RunFiles, sought: ReadonlyArray<{ scope: string; at: number }>): number[] {
  const seen = new Map<string, number[]>();
  for (const c of run.calls) {
    if (!c.acts.some((a) => VISIBLE.has(a.kind))) continue;
    seen.set(c.scope, [...(seen.get(c.scope) ?? []), c.at]);
  }
  for (const ts of seen.values()) ts.sort((a, b) => a - b);
  return sought.map((e) => {
    const next = (seen.get(e.scope) ?? []).find((t) => t >= e.at);
    return next === undefined ? Number.POSITIVE_INFINITY : next - e.at;
  });
}

type Call = RunFiles["calls"][number];

/** readback 的读数（量法见文件头）：该读回的调用里，"想过："的行数够了的占比；没有该读回的调用时是 null。 */
function readback(run: RunFiles, chat: "group" | "private" | undefined): number | null {
  const prompt = new Map(run.prompts.map((p) => [`${p.scope}@${p.at}`, p.user]));
  const sessions = run.dwell.flatMap((d) =>
    d.t === "end" && d.from !== undefined && d.at !== undefined
      ? [{ scope: d.scope, from: d.from, at: d.at }]
      : [],
  );
  const byScope = new Map<string, Call[]>();
  for (const c of run.calls) {
    if (chat && c.chatType !== chat) continue;
    byScope.set(c.scope, [...(byScope.get(c.scope) ?? []), c]);
  }
  let due = 0;
  let shown = 0;
  for (const [scope, calls] of byScope) {
    const sorted = [...calls].sort((a, b) => a.at - b.at);
    sorted.forEach((c, k) => {
      let going = 0;
      sorted.slice(0, k).forEach((s, j) => {
        if (!s.acts.some((a) => a.kind === "think")) return;
        const ok =
          c.chatType === "group"
            ? sessions.some(
                (d) =>
                  d.scope === scope && d.from - TURN_GAP <= s.at && d.from <= c.at && c.at <= d.at,
              )
            : privateGoing(sorted, j, k);
        if (ok) going++;
      });
      const want = Math.min(THOUGHT.shown, going);
      const user = prompt.get(`${c.scope}@${c.at}`);
      if (want === 0 || user === undefined) return;
      due++;
      if (linesOf(user).filter((l) => !l.carried).length >= want) shown++;
    });
  }
  return due === 0 ? null : shown / due;
}

/**
 * 私聊里从第 from 次调用到第 to 次，对话一直没断：每一次调用都离记录里最后一条不到 SEGMENT_GAP_MS；两次调用
 * 之间新来了消息时，最新那条离上一次调用也不到（新来的最早一条只会更近）。
 */
function privateGoing(calls: readonly Call[], from: number, to: number): boolean {
  for (let k = from + 1; k <= to; k++) {
    const prev = calls[k - 1];
    const cur = calls[k];
    if (!prev || !cur || cur.lastMessageAt == null) return false;
    const waited = cur.lastMessageAt > prev.at ? cur.lastMessageAt - prev.at : 0;
    if (waited > SEGMENT_GAP_MS || cur.at - cur.lastMessageAt > SEGMENT_GAP_MS) return false;
  }
  return true;
}

/** 带到私聊的寿命（inner.ts carry 用 DIARY.ttl）；在场看那个群最近几条消息的发言人（world.ts RECENT_IDS）。 */
const CARRY_FOR = DIARY.ttl;
const RECENT = 30;
const WRITE_SLACK = 2 * MIN;

/** 卡片上的"想过："行：带来的（"在群里想过："）和这个会话里的；截断的去掉结尾的"..."。 */
function linesOf(user: string): Array<{ carried: boolean; text: string }> {
  return Array.from(
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- 只读仿真自己渲染的提示词，每行很短
    user.matchAll(/^\s*- .*?(在群里|在「[^」]+」群里|在一个群里|和.+?私聊时)?想过：(.*)$/gm),
    (m) => ({
      carried: m[1] !== undefined,
      text: (m[2] ?? "").replace(/\.\.\.$/, ""),
    }),
  );
}

interface Thought {
  scope: string;
  at: number;
  text: string;
  /** 群里写下的：调用时和 WRITE_SLACK 之后都在场的人（sure），任一时在场的人（maybe）。 */
  present?: { sure: ReadonlySet<string>; maybe: ReadonlySet<string> };
}

/** 消息日志读出的在场：群里某一刻最近 RECENT 条消息的发言人；私聊的对方是那里第一条消息的发言人。 */
function presence(run: RunFiles) {
  const byScope = new Map<string, Array<{ at: number; from: string }>>();
  for (const m of [...(run.messages ?? []), ...(run.replies ?? [])]) {
    const list = byScope.get(m.scope) ?? [];
    list.push(m);
    byScope.set(m.scope, list);
  }
  for (const list of byScope.values()) list.sort((a, b) => a.at - b.at);
  return {
    at(scope: string, at: number): ReadonlySet<string> {
      const list = byScope.get(scope) ?? [];
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((list[mid] as { at: number }).at <= at) lo = mid + 1;
        else hi = mid;
      }
      return new Set(list.slice(Math.max(0, lo - RECENT), lo).map((m) => m.from));
    },
    partner: (scope: string): string | null => byScope.get(scope)?.[0]?.from ?? null,
  };
}

/** 她想过的（每个 <inner> 一条，空的不算，同 inner.ts），按时间排；群里的带着写下时谁在场。 */
function thoughtsOf(run: RunFiles, who: ReturnType<typeof presence>): Thought[] {
  const present = (scope: string, at: number) => {
    const [a, b] = [who.at(scope, at), who.at(scope, at + WRITE_SLACK)];
    return { sure: new Set([...a].filter((x) => b.has(x))), maybe: new Set([...a, ...b]) };
  };
  return run.calls
    .flatMap((c) =>
      c.acts.flatMap((a) =>
        a.kind === "think" && typeof a.thought === "string" && a.thought.trim()
          ? [
              {
                scope: c.scope,
                at: c.at,
                text: a.thought.trim(),
                ...(c.chatType === "group" ? { present: present(c.scope, c.at) } : {}),
              },
            ]
          : [],
      ),
    )
    .sort((a, b) => a.at - b.at);
}

/** carried 的读数（量法见文件头）。 */
function carried(run: RunFiles): number | null {
  const prompt = new Map(run.prompts.map((p) => [`${p.scope}@${p.at}`, p.user]));
  const who = presence(run);
  const inGroups = thoughtsOf(run, who).filter((t) => t.present);
  let due = 0;
  let shown = 0;
  for (const c of run.calls) {
    if (c.chatType !== "private") continue;
    const partner = who.partner(c.scope);
    const user = prompt.get(`${c.scope}@${c.at}`);
    if (partner === null || user === undefined) continue;
    const before = inGroups.filter((t) => t.at < c.at);
    const kept = [...new Set(before.map((t) => t.scope))].flatMap((s) =>
      before.filter((t) => t.scope === s).slice(-THOUGHT.shown),
    );
    const eligible = kept.filter(
      (t) => c.at - t.at <= CARRY_FOR && t.present?.sure.has(partner) === true,
    );
    const want = Math.min(THOUGHT.shown, eligible.length);
    if (want === 0) continue;
    due++;
    if (linesOf(user).filter((l) => l.carried).length >= want) shown++;
  }
  return due === 0 ? null : shown / due;
}

/** audience 的读数（量法见文件头）：违反的行数；卡片上没有一行"想过："时是 null。 */
function audience(run: RunFiles): number | null {
  const who = presence(run);
  const thoughts = thoughtsOf(run, who);
  const chatType = new Map(run.calls.map((c) => [`${c.scope}@${c.at}`, c.chatType]));
  let lines = 0;
  let bad = 0;
  for (const p of run.prompts) {
    const partner = chatType.get(`${p.scope}@${p.at}`) === "private" ? who.partner(p.scope) : null;
    for (const l of linesOf(p.user)) {
      lines++;
      const sources = thoughts.filter((t) => t.at < p.at && t.text.startsWith(l.text));
      const ok = l.carried
        ? partner !== null &&
          sources.some((t) => p.at - t.at <= CARRY_FOR && t.present?.maybe.has(partner) === true)
        : sources.some((t) => t.scope === p.scope);
      if (!ok) bad++;
    }
  }
  return lines === 0 ? null : bad;
}

/** repeat-carried 的读数（量法见文件头）。 */
function repeatCarried(run: RunFiles, chars: number): number | null {
  const calls = new Map(run.calls.map((c) => [`${c.scope}@${c.at}`, c]));
  const overlaps = (a: string, b: string) => {
    for (let i = 0; i + chars <= a.length; i++) if (b.includes(a.slice(i, i + chars))) return true;
    return false;
  };
  let due = 0;
  let hit = 0;
  for (const p of run.prompts) {
    const carriedText = linesOf(p.user)
      .filter((l) => l.carried)
      .map((l) => l.text);
    const c = calls.get(`${p.scope}@${p.at}`);
    if (carriedText.length === 0 || !c) continue;
    due++;
    const said = c.acts.flatMap((a) =>
      typeof a.text === "string" ? [a.text] : typeof a.thought === "string" ? [a.thought] : [],
    );
    if (said.some((s) => carriedText.some((l) => overlaps(s, l)))) hit++;
  }
  return due === 0 ? null : hit / due;
}
