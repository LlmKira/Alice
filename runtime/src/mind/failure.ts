/**
 * 没做成的原因：每个失败码一行，写明它算不算消息没发到对方那里、用她的话怎么说。
 * 外壳和执行器只写码；她看到的话（failures 机制、后台的事没办成时 step 写的那句）、操作员的告警（ops/watch）、
 * 北极星读数（northstar）都只读这张表，不再各自分类。
 */
import type { BackgroundUsage } from "./events.js";

/**
 * delivery：消息没发到对方是因为什么——refused 被拒绝（拉黑）、unreachable 发不到（没权限、不可达、注销）、
 * failed 其他原因没发到（结果未知、被连发上限拦下、语音没合成）；null 不是发送问题（她自己选错了、要等审批、
 * 额度、受众规则、暂停、停机），不告诉操作员。
 */
type Delivery = "refused" | "unreachable" | "failed" | null;

interface Row {
  delivery: Delivery;
  /**
   * 她的话：为什么没做成（写在"没发出去（……）""没结果（……）"的括号里）。不带人称：卡片里那句是"我刚才想发的……"，
   * 记录里那句是"你查了一下……"，同一个原因两处都用。
   */
  cause: string;
  /**
   * 这个会话此刻发不出去（没权限、被拉黑、限流、结果未知、暂停）：同一次决定里后面的动作也不做。
   * false 是只关于这一个动作的（表情不能用、贴纸词不对、那条消息不在了）：后面的照做。
   */
  stops: boolean;
}

export const FAILURES = {
  // 平台明确拒绝，或执行器确定没做（各平台的 errors.ts 分类）。
  invalid_sticker_keyword: { delivery: null, cause: "没有这个贴纸", stops: false },
  /** 相册里没有这个编号（她记错或编了一个）。 */
  invalid_asset: { delivery: null, cause: "相册里没有这张", stops: false },
  /** 这个会话不允许这个表情（群管理员限定了可用的表情）。 */
  invalid_reaction: { delivery: null, cause: "这里用不了这个表情", stops: false },
  peer_unreachable: { delivery: "unreachable", cause: "消息发不到这里", stops: true },
  transport_hard_permanent: {
    delivery: "unreachable",
    cause: "对方的账号已经注销了",
    stops: true,
  },
  transport_soft_permanent: { delivery: "unreachable", cause: "在这里没有权限", stops: true },
  /** 被执行器的连发上限（第二道防线）拦下：说明上游的连发控制出了错，操作员该知道。 */
  outgoing_burst_limited: { delivery: "failed", cause: "一下子发得太多了", stops: true },
  /** 对方把她拉黑了：不只是发不出去，是一次明确的拒绝（压力场记为被拒绝）。 */
  refused: { delivery: "refused", cause: "被对方拉黑了", stops: true },
  /** 语音没合成出来（合成服务出错、声音名不对）：什么也没发出去。 */
  voice_failed: { delivery: "failed", cause: "语音没录成", stops: false },
  /** 这条改不了（不是她发的、太久了）。 */
  edit_refused: { delivery: null, cause: "这条已经改不了了", stops: false },
  /** 动作指向的那条消息已经不在了（被删了；MESSAGE_ID_INVALID）：点表情、改、转发都可能碰上。 */
  message_gone: { delivery: null, cause: "那条消息已经不在了", stops: false },
  /** 对方设置了不收陌生人的私聊（只收联系人或 Premium 用户的）：不是拒绝她这个人。 */
  private_closed: { delivery: null, cause: "对方不收陌生人的私聊", stops: true },
  /** 平台暂时限制她给不是联系人的人发私聊（Telegram 的 PEER_FLOOD：被当成发得太多）。 */
  peer_flood: { delivery: null, cause: "平台暂时限制给不熟的人发私聊", stops: true },
  /** 要管理员审批的群：加入申请已经发出去了，还没进去（INVITE_REQUEST_SENT）。 */
  join_requested: { delivery: null, cause: "这个群要管理员同意，申请已经发出去了", stops: true },
  /** 最近找群、加群太频繁（执行器的次数上限，或平台的限流，如 Telegram 的 FLOOD_WAIT）。 */
  too_often: { delivery: null, cause: "最近找群、加群太频繁，平台限流了", stops: true },
  /** 按受众规则这条不能转到这里（私聊里的、或者对方当时不在场的群消息）。 */
  not_shareable: { delivery: null, cause: "那是别处的私事，不能转到这里", stops: false },
  // 外壳的码。
  /** 不知道做成没有（网络断了、没拿到消息 id、停机时还在途）：永远不重做。 */
  outcome_unknown: { delivery: "failed", cause: "不知道成没成", stops: true },
  /** 同一次决定里前一个动作没做成，这个就不做了。 */
  skipped_after_failure: { delivery: null, cause: "前面那件没做成", stops: true },
  /** 操作员暂停时没做的（不重做：继续之后由她下一次自己决定）。 */
  paused: { delivery: null, cause: "现在办不了这种事", stops: true },
  /** 上次停下时还没办完，结果不会回来了。 */
  interrupted: { delivery: null, cause: "中途断了", stops: true },
  /** 这种事现在办不了（没有给这类事的执行者）。 */
  unavailable: { delivery: null, cause: "现在查不了", stops: false },
  /** 后台的事没办成：原因是执行代理写的她的话（Failure 的 said）。 */
  errand: { delivery: null, cause: "没办成", stops: false },
} as const satisfies Record<string, Row>;

export type FailureCode = keyof typeof FAILURES;

/**
 * act.failed 的原因：码；后台的事没办成时另带执行代理写的她的话。
 * rpc：平台原样给的错误码（如 Telegram 的 USER_PRIVACY_RESTRICTED），几种错误共用一个码时靠它查是哪一种；心智不读它。
 * dmClosed：外壳确定对方不收她发起的私聊（对方的隐私设置，或拿到了访问凭证平台仍说没有这个人）。
 * 这是关于这个人的事实，不是这一次没发成（pressure/reach.ts 记下，之后不再对他发第一次私聊）。
 */
export type Failure =
  | { reason: Exclude<FailureCode, "errand">; rpc?: string; dmClosed?: true }
  | { reason: "errand"; said: string };

/** 只取失败原因（去掉事件的其他字段）。 */
export function failureIn(f: Failure): Failure {
  return f.reason === "errand" ? { reason: f.reason, said: f.said } : { reason: f.reason };
}

/** 她看到的那句原因。 */
export function failureText(failure: Failure): string {
  return failure.reason === "errand" ? failure.said : FAILURES[failure.reason].cause;
}

/** 发言、想一想的调用没成：模型那边出错（error 是报错文字，诊断用）、上次停下时在途、暂停。 */
export type CallFailure = "model" | "interrupted" | "paused";

/** 带失败码的错误：执行器和后台的事抛它，外壳原样写进 act.failed。其他错误一律记为 outcome_unknown。 */
export class Failed extends Error {
  constructor(
    readonly failure: Failure,
    message: string = failure.reason,
    /** 后台的事没办成也花了钱。 */
    readonly usage?: BackgroundUsage,
  ) {
    super(message);
    this.name = "Failed";
  }
}
