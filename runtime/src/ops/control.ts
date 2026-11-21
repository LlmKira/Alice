/**
 * 操作员控制面的状态与命令（capabilities X03）。暂停是外壳的状态，不是她经历的事：不进 Journal，
 * 存在状态目录下的 ops-control.json，所以进程重启（pm2、崩溃）之后仍是暂停。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ControlState {
  paused: boolean;
  /** operator：操作员发的暂停；spend-cap：当天花费到了上限。 */
  reason: "operator" | "spend-cap" | null;
  since: number | null;
  /** 操作员为某一天改过的花费上限（美元）；只在那一天有效。 */
  cap: { day: string; usd: number } | null;
}

export const RUNNING: ControlState = { paused: false, reason: null, since: null, cap: null };

export function loadControl(path: string): ControlState {
  if (!existsSync(path)) return RUNNING;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ControlState>;
  return {
    paused: raw.paused === true,
    reason: raw.reason === "operator" || raw.reason === "spend-cap" ? raw.reason : null,
    since: typeof raw.since === "number" ? raw.since : null,
    cap:
      raw.cap && typeof raw.cap.day === "string" && typeof raw.cap.usd === "number"
        ? raw.cap
        : null,
  };
}

/** 先写临时文件再改名：写到一半被杀也不会留下读不懂的状态。 */
export function saveControl(path: string, state: ControlState): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * 操作员命令的前缀。私聊里正常说话不会这样开头，所以和闲聊分得开；命令消息不进她的时间线。
 */
export const COMMAND_PREFIX = "/ops";

export type OperatorCommand =
  | { verb: "status" | "pause" | "resume" | "stop" | "help" | "selftest" }
  | { verb: "cap"; usd: number };

const VERBS: Record<string, "status" | "pause" | "resume" | "stop" | "help" | "selftest"> = {
  selftest: "selftest",
  自检: "selftest",
  status: "status",
  状态: "status",
  pause: "pause",
  暂停: "pause",
  resume: "resume",
  继续: "resume",
  stop: "stop",
  停: "stop",
  help: "help",
};

/**
 * 解析操作员命令：`/ops <动词> [参数]`。不是这个前缀开头的返回 null（是普通聊天）；
 * 前缀对了但动词认不出的当作 help（命令不能漏进她的时间线）。
 */
export function parseOperatorCommand(text: string | null): OperatorCommand | null {
  if (text === null) return null;
  const words = text.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== COMMAND_PREFIX) return null;
  const verb = words[1]?.toLowerCase() ?? "status";
  if (verb === "cap" || verb === "上限") {
    const usd = Number(words[2]);
    return Number.isFinite(usd) && usd > 0 ? { verb: "cap", usd } : { verb: "help" };
  }
  return { verb: VERBS[verb] ?? "help" };
}

export const HELP = [
  `${COMMAND_PREFIX} status   运行多久、各会话数、今天的调用与花费、最近的失败`,
  `${COMMAND_PREFIX} pause    暂停：不调模型、不对外做任何事，收到的消息照常记下`,
  `${COMMAND_PREFIX} resume   继续`,
  `${COMMAND_PREFIX} cap 5    把今天的花费上限改成 5 美元（只管今天）`,
  `${COMMAND_PREFIX} stop     停：干净退出，pm2 不会再拉起来`,
  `${COMMAND_PREFIX} selftest 发一张贴纸、一条语音到这里，看发不发得出去（不进她的记录）`,
].join("\n");
