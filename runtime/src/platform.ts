/**
 * 聊天平台接口：她通过哪个平台和人来往（Telegram、QQ）。运行时（index.ts）只依赖这一个接口：
 * 平台把那边发生的事写成 AliceEvent 交给运行时；运行时要她做的对外动作由平台执行，返回 ActOutcome 或抛 Failed。
 * 客户端、入站解析、补拉、限额，以及平台从日志算出的状态（相册、去重、群资料）都封装在平台内部，运行时不碰。
 *
 * 不变量：
 * - 平台的事件只经 host.dispatch 交出；平台的投影只在 observe 里更新（启动 fold 和运行时走同一个钩子），
 *   所以投影里不会出现日志里没有的东西。
 * - act 抛 Failed 表示确定没做成，其他错误表示结果未知（外壳记为 outcome_unknown，永不重做）。
 * - 构造平台不连网络（`--check` 只构造、fold、读 startupInfo）；连接只在 start 里。
 */
import type { PlatformConfig } from "./config.js";
import type { QueryKind } from "./llm/ptc.js";
import type { Act, PlatformCapabilities } from "./mind/affordances.js";
import type { AliceEvent, FoundPlace } from "./mind/events.js";
import { Failed } from "./mind/failure.js";
import type { ActOutcome } from "./mind/outcome.js";
import type { AliceState } from "./mind/state.js";
import type { Pause } from "./ops/gate.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("runtime");

/** 看图、听语音（llm/perceive.ts）、看贴纸（sticker-palette.ts）。由运行时提供，操作员暂停时已经会拒绝。 */
interface Perceivers {
  image: (jpeg: Uint8Array) => Promise<string>;
  gif: (jpeg: Uint8Array) => Promise<string>;
  video: (jpeg: Uint8Array) => Promise<string>;
  voice: (ogg: Uint8Array) => Promise<string>;
  /**
   * 看一张贴纸，返回时间线里那一行。按平台加 fileUniqueId 缓存，没看过才调 load 取图；
   * 带 fileId 时顺带收进这个平台的贴纸库，之后她能用 sticker 发出去。
   */
  sticker: (
    meta: {
      platform: string;
      fileId?: string;
      fileUniqueId?: string;
      emoji?: string;
      setTitle?: string;
    },
    load: () => Promise<Uint8Array>,
  ) => Promise<string>;
}

/** 平台启动时，运行时传给它的依赖。 */
export interface PlatformHost {
  /** 提交一个入站事件：运行时先拦下操作员命令，其余写进 Journal、交给 step()。 */
  dispatch: (event: AliceEvent) => void;
  now: () => number;
  /** 她此刻的状态（只读；例如语音通话要看最近的聊天）。 */
  state: () => AliceState;
  pause: Pause;
  perceive: Perceivers;
  /** 后台任务的中止信号，停机时触发。 */
  signal: AbortSignal;
  /** 登记一个后台任务：停机时先等它结束（有上限），再关连接、关库。 */
  track: <T>(task: Promise<T>) => Promise<T>;
  /** 上报连接状态（connected 或其他），用于给操作员发掉线告警。 */
  connection: (state: string) => void;
  warn: (message: string, error?: unknown) => void;
}

/** 平台自己执行的查询的结果（delegate 由运行时处理）。 */
export interface QueryResult {
  value: unknown;
  result: string;
  found?: FoundPlace[];
}

export interface Platform {
  readonly name: PlatformConfig["name"];
  /** 这个平台负责的会话前缀（如 "telegram:"、"qq:"）；PlatformHub 按它分发事件和动作。 */
  readonly prefix: string;
  /** 本平台实际支持的对外动作。提示词、意愿层和 settle 都只放行这里声明的动作。 */
  readonly capabilities: PlatformCapabilities;
  /**
   * 收到一个已写进日志、已经过 step 的事件（state 是 step 之后的状态），据此更新平台的投影。
   * fold 是启动时重放历史，live 是运行中；只应从历史恢复的计数（限额）只在 fold 时记。不能抛错。
   */
  observe: (event: AliceEvent, state: AliceState, phase: "fold" | "live") => void;
  /** 启动日志里由平台提供的几项（贴纸张数、相册图片数……）；在 fold 之后、start 之前读取。 */
  startupInfo: () => Record<string, unknown>;
  /** 连接平台、开始接收入站消息、启动平台自己的后台任务；返回她在这个平台上的 id 与当前账号显示名。 */
  start: (host: PlatformHost) => Promise<{ selfId: string; selfName?: string }>;
  act: (scope: string, act: Act, signal: AbortSignal) => Promise<ActOutcome>;
  query: (
    scope: string,
    kind: Exclude<QueryKind, "delegate">,
    act: Act,
    signal: AbortSignal,
  ) => Promise<QueryResult>;
  /** 当前可用贴纸的简短描述（只读本地数据）；不支持贴纸的平台返回空列表。 */
  stickers: () => readonly string[];
  sendToOperator: (text: string) => Promise<void>;
  /** 操作员自检：走和她相同的执行路径，但不写 Journal；每项结果占一行。 */
  selftest: () => Promise<string>;
  /** 停机：在后台任务结束之后调用，关闭连接和平台自己的数据库。没调用过 start 也可以调。 */
  stop: () => Promise<void>;
}

/** 操作员自检：依次发一张贴纸、一条语音，每项结果占一行（失败的附上失败码）。 */
export async function selftestReport(execute: (act: Act) => Promise<unknown>): Promise<string> {
  const tries: Array<[string, Act]> = [
    ["贴纸", { kind: "sticker", word: "happy" }],
    ["语音", { kind: "voice", text: "喂，听得到吗？是我呀。" }],
  ];
  const lines: string[] = [];
  for (const [name, act] of tries) {
    try {
      await execute(act);
      lines.push(`${name}：发出去了`);
    } catch (error) {
      const why = error instanceof Failed ? error.failure.reason : String(error).slice(0, 120);
      lines.push(`${name}：没发出去（${why}）`);
      log.warn("Selftest failed", { act: act.kind, error });
    }
  }
  return lines.join("\n");
}
