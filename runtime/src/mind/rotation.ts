/**
 * 线上轮换（PLAN 第 25 件；研究员 2026-11-13："可以啊。你可以用 seed 决定的。"）：生产和一个候选同时挂着，
 * 每个分组单位在每个时间段用哪一套，由种子的哈希算出；真的换组只在她不在对话里的时候。纯函数：时间只来自参数，
 * 随机只来自种子的哈希。
 *
 * - 单位：候选改动（换掉、拿掉或加上）的机制里有跨会话的钩子（叫醒、看一眼、想一想、开新会话、扫一眼——压力场
 *   这一类，比如一部手机管所有群），就按她这个人整体切（self），所有会话同时换；只改会话里面的东西（提示词里的
 *   事实和示例、记录怎么排、给哪些能力），按会话分（chat）。按会话分时，跨会话的钩子（想一想、开新会话、扫一眼）
 *   照生产。
 * - 时间段：她的一天，东八区 DAY_START_HOUR 点到次日同一时刻。依据（eval-artifacts/rotation/blocks.out，2 月
 *   三份、7 月、线上共 5 份记录）：4–7 点每小时的消息不到全天的 0.5%；7 点切的 10 次里没有一段对话被切断，
 *   等到她不在对话里最多 4.9 分钟。她按作息这时还睡着（sleep.ts，睡眠中点 5:30）。北极星的线上读数也按天。
 *   比一天短的段会把组和一天里的钟点绑在一起，她的心情、精力、手机这些以小时计的状态还会带进下一段。
 * - 平衡：相邻两段配成一对，一段生产一段候选，先后由种子定（交叉设计）。所以每个单位每两天两组各一天，
 *   不会连着好几天落在同一组。
 * - 什么时候真的换（inConversation）：按会话分时，那个会话里她不在对话里；整体切时，所有会话里她都不在对话里。
 *   "在对话里"：她在那里等着开口、在想、有交出去还没回来的事，或者眼下这段对话（时间线末尾相邻不超过 QUIET_MS
 *   的那一串，最后一条在 QUIET_MS 之内）里有她说的话、有冲着她的话。QUIET_MS 是真人一段在线的分界：同一人相邻
 *   两轮间隔的两峰之间，5.2 分钟（docs/research/phone-focus-2026-11-13.md，2 月 0、A、B 和线上）。
 *   还没换到这一段排的组时，单位留在原来的组，到点前一刻开始的对话照旧用原来那套说完。
 *
 * 换组由外壳在时钟格之前算（switchesDue），写成 arm.switched 进 Journal，再送进 step；step 只照记录换。
 * 所以折叠、回放和北极星读的是同一份分组，换了配置重启也不会改写过去。
 */
import { hash32 } from "../mechanisms/hash.js";
import { SELF_SCOPE } from "./effects.js";
import type { ArmSwitched } from "./events.js";
import type { Mechanism } from "./mechanism.js";
import type { AliceState, ChatState } from "./state.js";
import { localDay } from "./when.js";

const MIN = 60_000;
const H = 60 * MIN;

export type ArmName = "production" | "candidate";
export type RotationUnit = "chat" | "self";

export interface Rotation {
  /** 候选的名字（sim/will-arms.ts 的组名），写进每条 arm.switched。 */
  candidate: string;
  /** 分组的种子（配置给的字符串）：同样的种子、单位和时间段永远算出同样的组。 */
  seed: string;
  unit: RotationUnit;
}

/** 挂着两套配置的心智。 */
export interface Rotating {
  readonly rotation: Rotation;
  readonly production: readonly Mechanism[];
  /** 候选的机制：和生产同名而不是同一个的，名字改成"名字@候选"，两套的状态各存各的。 */
  readonly candidate: readonly Mechanism[];
  /** 每个事件都折叠的：生产的，加上候选独有的（两套的状态一直都是热的，换组那一刻不用从头攒）。 */
  readonly folded: readonly Mechanism[];
}

/** step 和外壳拿到的心智：只有一套（就是现在的生产，逐字节不变），或者两套轮换。 */
export type Mind = readonly Mechanism[] | Rotating;

/** 时间段从东八区几点开始（见文件头）。 */
export const DAY_START_HOUR = 7;
/** 真人一段在线的分界（见文件头）。 */
export const QUIET_MS = 5.2 * MIN;

export function isRotating(mind: Mind): mind is Rotating {
  return "rotation" in mind;
}

/** 有跨会话钩子的机制：它一动，别的会话里她做什么也跟着变。 */
function personLevel(m: Mechanism): boolean {
  return !!(m.wake || m.glance || m.ponder || m.opens || m.scans || m.asleep);
}

/** 候选和生产不同的机制里有跨会话的，就只能整体切。 */
export function unitOf(
  production: readonly Mechanism[],
  candidate: readonly Mechanism[],
): RotationUnit {
  const changed = [
    ...candidate.filter((m) => !production.includes(m)),
    ...production.filter((m) => !candidate.includes(m)),
  ];
  return changed.some(personLevel) ? "self" : "chat";
}

/** 组装两套。unit 不给就按 unitOf 定；给了 chat 而候选有跨会话的改动，报错（两套会在一个时钟格里互相抢）。 */
export function rotating(
  rotation: Omit<Rotation, "unit"> & { unit?: RotationUnit },
  production: readonly Mechanism[],
  candidate: readonly Mechanism[],
): Rotating {
  const needs = unitOf(production, candidate);
  const unit = rotation.unit ?? needs;
  if (unit === "chat" && needs === "self") {
    throw new Error(
      `candidate ${rotation.candidate} changes a mechanism that acts across chats; rotate it by self`,
    );
  }
  const names = new Set(production.map((m) => m.name));
  const own = candidate.map((m) =>
    production.includes(m) || !names.has(m.name)
      ? m
      : { ...m, name: `${m.name}@${rotation.candidate}` },
  );
  return {
    rotation: { ...rotation, unit },
    production,
    candidate: own,
    folded: [...production, ...own.filter((m) => !production.includes(m))],
  };
}

/** 第几个时间段：东八区 DAY_START_HOUR 点起算的日子。 */
export function blockOf(at: number): number {
  return localDay(at - DAY_START_HOUR * H);
}

/** 这个单位在这个时间段排的组：两段一对，一段生产一段候选，先后由种子定。 */
export function scheduled(rotation: Rotation, unit: string, block: number): ArmName {
  const pair = Math.floor(block / 2);
  const first: ArmName =
    hash32(`${rotation.seed}|${unit}|${pair}`) % 2 === 0 ? "production" : "candidate";
  if (block % 2 === 0) return first;
  return first === "production" ? "candidate" : "production";
}

/** 分组单位的键：按会话分是会话，整体切是 "self"。 */
export function unitKey(rotation: Rotation, scope: string): string {
  return rotation.unit === "self" ? SELF_SCOPE : scope;
}

/** 此刻她在不在这个会话的对话里（见文件头）。 */
export function inConversation(chat: ChatState, at: number): boolean {
  if (chat.mind.mode !== "idle" || chat.running.length > 0) return true;
  const t = chat.timeline;
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i] as ChatState["timeline"][number];
    const after = i === t.length - 1 ? at : (t[i + 1] as ChatState["timeline"][number]).at;
    if (after - e.at > QUIET_MS) return false;
    if (!e.sender || e.directed) return true;
  }
  return false;
}

/**
 * 此刻该换组的单位（外壳在每个时钟格之前问一次，回放也是）：这一段排的组和现在的不同（或候选换了名字、还没分过组），
 * 她在那里不在对话里。别的单位方式留下的记录（换了 unit 重启）当即收回：它们已经不决定什么了。
 */
export function switchesDue(state: AliceState, at: number, mind: Rotating): ArmSwitched[] {
  const { rotation } = mind;
  const block = blockOf(at);
  const chats = Object.values(state.chats);
  const units = rotation.unit === "self" ? [SELF_SCOPE] : chats.map((c) => c.scope);
  const out: ArmSwitched[] = [];
  for (const [key, was] of Object.entries(state.arms ?? {})) {
    if ((rotation.unit === "self") !== (key === SELF_SCOPE)) {
      out.push({
        type: "arm.switched",
        at,
        scope: key,
        arm: null,
        candidate: was.candidate,
        block,
      });
    }
  }
  for (const key of units) {
    const arm = scheduled(rotation, key, block);
    const now = state.arms?.[key];
    if (now?.arm === arm && now.candidate === rotation.candidate) continue;
    const busy =
      rotation.unit === "self"
        ? chats.some((c) => inConversation(c, at))
        : inConversation(state.chats[key] as ChatState, at);
    if (busy) continue;
    out.push({ type: "arm.switched", at, scope: key, arm, candidate: rotation.candidate, block });
  }
  return out;
}

/** 轮换关了：收回所有分组记录（外壳启动时，心智只有一套而状态里还有组）。 */
export function rotationEnded(state: AliceState, at: number): ArmSwitched[] {
  return Object.entries(state.arms ?? {}).map(([scope, was]) => ({
    type: "arm.switched",
    at,
    scope,
    arm: null,
    candidate: was.candidate,
    block: blockOf(at),
  }));
}

/** 照记录换组。 */
export function switchArm(state: AliceState, event: ArmSwitched): AliceState {
  const arms = { ...(state.arms ?? {}) };
  if (event.arm === null) delete arms[event.scope];
  else arms[event.scope] = { arm: event.arm, candidate: event.candidate, since: event.at };
  return { ...state, arms };
}

/** 这个单位眼下在哪一组：记录说是这个候选的候选组才是候选，其余（没分过组、别的候选留下的）都是生产。 */
export function armOf(mind: Rotating, state: AliceState, scope: string): ArmName {
  const a = state.arms?.[unitKey(mind.rotation, scope)];
  return a?.arm === "candidate" && a.candidate === mind.rotation.candidate
    ? "candidate"
    : "production";
}

/**
 * 在这个会话里做决定用哪一套；scope 为 null 是她自己的事（想一想、开新会话、扫一眼）：整体切时跟她的组，
 * 按会话分时照生产。
 */
export function mechanismsIn(
  mind: Mind,
  state: AliceState,
  scope: string | null,
): readonly Mechanism[] {
  if (!isRotating(mind)) return mind;
  if (scope === null && mind.rotation.unit === "chat") return mind.production;
  return armOf(mind, state, scope ?? SELF_SCOPE) === "candidate" ? mind.candidate : mind.production;
}

/** 每个事件都要折叠的机制。 */
export function foldedOf(mind: Mind): readonly Mechanism[] {
  return isRotating(mind) ? mind.folded : mind;
}

/** 此刻按当前激活的心智配置，她是不是正在睡觉。 */
export function isAsleepIn(mind: Mind, state: AliceState, now: number): boolean {
  return mechanismsIn(mind, state, null).some(
    (m) =>
      m.asleep?.(now, m.name in state.mechanisms ? state.mechanisms[m.name] : m.initial) ?? false,
  );
}
