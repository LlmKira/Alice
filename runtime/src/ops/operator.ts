/**
 * 操作员控制面（capabilities X03、X04）：操作员（ALICE_OPERATOR_ID 给出的 Telegram 用户，或 QQ_OPERATOR_ID
 * 给出的 QQ 号，见 ops/config.ts）私聊她时，
 * 以 `/ops` 开头的消息是命令，不进她的时间线：状态、暂停、继续、改今天的花费上限、停。
 * 这里也管按天的花费上限（到了自动暂停并告诉操作员）和自检告警（watch.ts）。
 *
 * 暂停的做法见 gate.ts：端口当即拒绝（Failed paused），外壳按失败写回，在办的后台的事被中止；时钟不走，
 * 入站照常先写日志再 step。失败的永远不重做，继续之后由她自己决定要不要再开口。
 */
import type { Spent } from "../llm/gateway.js";
import type { AliceEvent } from "../mind/events.js";
import type { AliceState } from "../mind/state.js";
import {
  type ControlState,
  HELP,
  loadControl,
  type OperatorCommand,
  parseOperatorCommand,
  RUNNING,
  saveControl,
} from "./control.js";
import { dayKey, SPEND_KINDS, type SpendKind, type SpendMeter } from "./spend.js";
import { Watch } from "./watch.js";

/** 没有设 ALICE_DAILY_USD_CAP 时的日上限（美元）：比真模型窗口里一天的花费高一截，远低于"悄悄烧钱"。 */
export const DEFAULT_DAILY_CAP_USD = 3;

const KIND_NAMES: Record<SpendKind, string> = {
  speech: "发言",
  ponder: "想一想",
  image: "看图",
  voice: "听语音",
  rerank: "翻相册",
  tts: "语音合成",
  errand: "执行代理",
  tone: "判口气",
};

export interface OperatorPorts {
  now: () => number;
  /** 私聊操作员（不经她的发送链，不进 Journal）。 */
  send: (text: string) => Promise<void>;
  /** 干净退出（退出码 0，pm2 的 stop_exit_codes 让它不再拉起）。 */
  stop: () => void;
  /** 她此刻的状态（只读，用来数会话）。 */
  state: () => AliceState;
  /** 走她自己的执行路径往操作员私聊发一张贴纸、一条语音，返回每样成没成（不进 Journal）。 */
  selftest: () => Promise<string>;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OperatorOptions {
  operatorId: string;
  /**
   * 操作员的私聊会话（如 telegram:<id>、qq:private:<QQ 号>）：只认这些会话里的 /ops 命令。
   * 各平台的数字 id 是不同的号码，只比 senderId 会让 QQ 上同号的陌生人当上操作员。
   * 不给时退回只比 senderId（单平台的老调用方）。
   */
  operatorScopes?: ReadonlySet<string>;
  /** ops-control.json 的路径。 */
  controlPath: string;
  spend: SpendMeter;
  capUsd: number;
}

const clock = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(11, 16);
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} 小时 ${m % 60} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

export class Operator {
  readonly watch: Watch;
  private control: ControlState;
  private readonly startedAt: number;
  private readonly pauseListeners: Array<() => void> = [];

  constructor(
    private readonly ports: OperatorPorts,
    private readonly options: OperatorOptions,
  ) {
    this.startedAt = ports.now();
    this.control = loadControl(options.controlPath);
    this.watch = new Watch(ports.now, (text) => void this.tell(text));
  }

  get paused(): boolean {
    return this.control.paused;
  }

  /** 今天的上限：操作员今天改过就用改过的。 */
  cap(): number {
    const today = dayKey(this.ports.now());
    return this.control.cap?.day === today ? this.control.cap.usd : this.options.capUsd;
  }

  /**
   * 入站消息：操作员私聊里的命令在这里处理，返回 true（不送进 Journal，不进她的时间线）。
   * 别人发的同样文字、操作员在群里发的，都是普通消息。
   */
  intercept(event: AliceEvent): boolean {
    if (event.type !== "message.received" || event.chatType !== "private") return false;
    const { operatorScopes, operatorId } = this.options;
    const fromOperator = operatorScopes
      ? operatorScopes.has(event.scope)
      : event.senderId === operatorId;
    if (!fromOperator) return false;
    const command = parseOperatorCommand(event.text);
    if (!command) return false;
    void this.run(command);
    return true;
  }

  /** 外壳写进 Journal 的每个事件：自检。 */
  observe(event: AliceEvent): void {
    this.watch.observe(event);
  }

  /**
   * 记一笔花费（llm/gateway.ts 的记账回调：每次模型调用、每次搜索）；当天合计到了上限就暂停，
   * 并告诉操作员（这一条不限频）。
   */
  charge({ kind, usd: amount, ...detail }: Spent): void {
    const day = this.options.spend.record(kind, amount, detail);
    if (this.control.paused || day.total < this.cap()) return;
    this.setPaused(true, "spend-cap");
    void this.tell(
      `今天的模型花费 ${usd(day.total)} 到了上限 ${usd(this.cap())}，已经暂停。` +
        `要继续：/ops cap <美元> 提高今天的上限，再 /ops resume。`,
    );
  }

  status(): string {
    const now = this.ports.now();
    const chats = Object.values(this.ports.state().chats);
    const count = (type: "private" | "group", member: boolean) =>
      chats.filter((c) => c.chatType === type && c.member === member).length;
    const day = this.options.spend.today();
    const calls = SPEND_KINDS.reduce((n, k) => n + day.calls[k], 0);
    const byKind = SPEND_KINDS.filter((k) => day.calls[k] > 0)
      .map((k) => `${KIND_NAMES[k]} ${day.calls[k]} 次 ${usd(day.usd[k])}`)
      .join(" · ");
    const pause = this.control.paused
      ? `暂停中（${this.control.reason === "spend-cap" ? "花费到了上限" : "操作员"}${
          this.control.since === null ? "" : `，${clock(this.control.since)} 起`
        }）`
      : "在运行";
    const left = count("group", false) + count("private", false);
    const failures = this.watch.recent
      .slice(-5)
      .map((f) => `  ${clock(f.at)} ${f.scope} ${f.what}：${f.reason.slice(0, 80)}`);
    return [
      `${pause}，已运行 ${duration(now - this.startedAt)}`,
      `聊天平台：${this.watch.connected ? "已连接" : "断开"}`,
      `会话：私聊 ${count("private", true)}，群 ${count("group", true)}${left > 0 ? `（已不在 ${left}）` : ""}`,
      `今天（${day.day}）：模型调用 ${calls} 次，${usd(day.total)} / 上限 ${usd(this.cap())}`,
      ...(byKind ? [`  ${byKind}`] : []),
      `错误日志近 10 分钟 ${this.watch.errorsInWindow()} 条`,
      ...(failures.length > 0 ? ["最近的失败：", ...failures] : ["最近没有失败"]),
    ].join("\n");
  }

  /** 心跳日志的字段（index.ts 每 5 分钟写一行）。 */
  heartbeat(): Record<string, unknown> {
    const day = this.options.spend.today();
    return {
      uptimeMin: Math.floor((this.ports.now() - this.startedAt) / 60_000),
      paused: this.control.paused,
      reason: this.control.reason,
      chats: Object.keys(this.ports.state().chats).length,
      calls: SPEND_KINDS.reduce((n, k) => n + day.calls[k], 0),
      usd: Number(day.total.toFixed(4)),
      cap: this.cap(),
      telegram: this.watch.connected ? "connected" : "offline",
      errors10m: this.watch.errorsInWindow(),
    };
  }

  private async run(command: OperatorCommand): Promise<void> {
    this.ports.log("operator command", { verb: command.verb });
    switch (command.verb) {
      case "status":
        return this.tell(this.status());
      case "help":
        return this.tell(HELP);
      case "selftest":
        return this.tell(await this.ports.selftest());
      case "pause":
        if (!this.control.paused) this.setPaused(true, "operator");
        return this.tell(
          "已暂停：不调模型、不对外做任何事，收到的消息照常记下。/ops resume 继续。",
        );
      case "resume": {
        const spent = this.options.spend.today().total;
        if (spent >= this.cap()) {
          return this.tell(
            `今天已经花了 ${usd(spent)}，不低于上限 ${usd(this.cap())}，继续了也会马上停。先 /ops cap <美元>。`,
          );
        }
        if (this.control.paused) this.setPaused(false, null);
        return this.tell("继续了。");
      }
      case "cap": {
        this.control = {
          ...this.control,
          cap: { day: dayKey(this.ports.now()), usd: command.usd },
        };
        this.save();
        return this.tell(
          `今天的花费上限改成 ${usd(command.usd)}（今天已花 ${usd(this.options.spend.today().total)}）。`,
        );
      }
      case "stop":
        await this.tell("好，停了。要再开：pm2 start ecosystem.config.cjs");
        this.ports.stop();
        return;
    }
  }

  private setPaused(paused: boolean, reason: ControlState["reason"]): void {
    this.control = paused
      ? { ...this.control, paused, reason, since: this.ports.now() }
      : { ...RUNNING, cap: this.control.cap };
    this.save();
    this.ports.log(paused ? "paused" : "resumed", { reason });
    if (paused) for (const listener of this.pauseListeners) listener();
  }

  /** 从运行变成暂停时（操作员 /ops pause，或到了花费上限）：gate.ts 中止在办的后台的事。 */
  onPause(listener: () => void): void {
    this.pauseListeners.push(listener);
  }

  private save(): void {
    try {
      saveControl(this.options.controlPath, this.control);
    } catch (error) {
      this.ports.log("control state write failed", { error: String(error) });
    }
  }

  private async tell(text: string): Promise<void> {
    try {
      await this.ports.send(text);
    } catch (error) {
      this.ports.log("operator message failed", { error: String(error) });
    }
  }
}
