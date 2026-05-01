/**
 * Shell-native script executor.
 *
 * This is the primary Alice truth model: the LLM writes a POSIX sh script and the
 * runtime executes it inside a Docker container (alice-skill-runner image).
 *
 * All LLM-controlled scripts are forced through container isolation.
 * Host execution was removed — LLM must never have unsandboxed shell access.
 */

import { DEFAULT_DOCKER_IMAGE } from "../skills/backends/docker.js";
import { ALICE_HOME, executeAliceSandboxProcess } from "../skills/container-runner.js";
import { buildInstalledSkillEnv } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";
import {
  type ExecutionObservation,
  isExecutionObservation,
  isScriptExecutionErrorCode,
  isScriptExecutionErrorDetail,
  type ScriptExecutionErrorDetail,
  type ScriptExecutionResult,
} from "./script-execution.js";
import { validateScript } from "./script-validator.js";

const log = createLogger("shell-executor");
const ACTION_PREFIX = "__ALICE_ACTION__:";
const ERROR_PREFIX = "__ALICE_ERROR__:";
const ERROR_DETAIL_PREFIX = "__ALICE_ERROR_DETAIL__:";
const OBSERVATION_PREFIX = "__ALICE_OBSERVATION__:";

/**
 * 中心化清洗：剥离 CLI 输出中 LLM 不应看到的噪音。
 *
 * 在数据入口点（shell-executor stdout/stderr 解析处）一处清洗，
 * 全链路受益——output-presenter、observations、prompt 渲染都看到干净文本。
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 转义码
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 序列（终端标题等）
const OSC_RE = /\x1b\][^\x07]*\x07/g;
// 某些链路会丢掉 ESC，只留下 `[4m` / `[22m` 这类半截 ANSI 残片。
// 这里直接匹配常见 ANSI/CSI 终止字母，宁可多杀一点终端噪音，也不把乱码送给 LLM。
const ORPHAN_ANSI_FRAGMENT_RE = /\[[0-9;]{1,6}(?:m|[ABCDHJKSTfhlmnsu])/g;
// 零宽字符/BOM 对 LLM 无信息价值，且容易表现成“乱码”。
const INVISIBLE_NOISE_RE = /[\u200b-\u200f\u2060\ufeff]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 残留控制字符（\b backspace, \x7f DEL 等，保留 \t \n \r）
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x7f]/g;

function sanitizeForLLM(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, "") // [36m, [1m, [0m 等颜色/粗体/重置
    .replace(OSC_RE, "") // 终端标题设置等 OSC 序列
    .replace(ORPHAN_ANSI_FRAGMENT_RE, "") // [4m / [1m / [22m 这类失去 ESC 的残片
    .replace(INVISIBLE_NOISE_RE, "") // 零宽空格、BOM 等不可见噪音
    .replace(CONTROL_CHAR_RE, ""); // 残留控制字符
}

// Engine API 端口（由 index.ts 启动后注入）
let _enginePort = 0;
export function setEnginePort(port: number) {
  _enginePort = port;
}
export function getEnginePort(): number {
  return _enginePort;
}

/** 返回 { ALICE_ENGINE_URL } 环境变量（宿主侧 localhost）。端口未设置时返回空对象。 */
export function engineUrlEnv(): Record<string, string> {
  return _enginePort ? { ALICE_ENGINE_URL: `http://127.0.0.1:${_enginePort}` } : {};
}

export { ALICE_HOME };

/**
 * Alice 已知系统命令名（用于单行脚本归一化）。
 * @see src/skills/registry.ts — BUILTIN_SYSTEM_REGISTRY
 */
// 预留：命令检测正则（preprocessScript 重构时使用）
// const ALICE_COMMANDS = /\b(irc|album|self|engine|alice-pkg)\b/;

function preprocessScript(script: string): string {
  let s = script.trim();
  if (/^```(?:sh|bash|shell)\n?/i.test(s)) {
    s = s.replace(/^```(?:sh|bash|shell)\n?/i, "");
    s = s.replace(/\n?```$/, "");
  }
  s = s.trim();
  // Structured outputs sometimes preserve the markdown language label as the
  // first script line. The executor already invokes /bin/sh; strip the label.
  s = s.replace(/^(?:sh|bash|shell)\s*\n/i, "").trim();

  // ── 单行归一化 ──
  // LLM 有时输出单行脚本：`# 思考1# 思考2irc say "hello" self feel ...`
  // 在 shell 中 `#` 注释吃掉整行，导致所有命令失效。
  // 修复：在 # 注释边界和已知命令边界前插入换行。
  if (!s.includes("\n")) {
    // 1. 在 mid-line `# ` 前插入换行（拆分内心独白）
    s = s.replace(/(?<=\S)\s*(?=# )/g, "\n");
    // 2. 在已知命令名前插入换行（拆分命令）
    //    (?<=['"。！？.!?\s]) 要求前面是引号、标点或空白——避免拆碎单词
    //    \b 要求是完整命令名——`self-conscious` 中的 self 后面跟 `-` 不匹配
    s = s.replace(
      /(?<=['"\u3002\uff01\uff1f.!?\s])((?:irc|album|self|engine|alice-pkg)\b)/g,
      "\n$1",
    );
  }

  return s.trim();
}

/**
 * 从脚本源码中提取 `# ...` 注释作为 LLM 的内心独白（thinks）。
 *
 * Shell 合约："Use `# ...` comments as your inner monologue"。
 * 这些注释是 LLM 的认知轨迹（ReAct Thought），需要被捕获到
 * thinks[] → feedback-arc reasoning → action_log.reasoning 管线。
 *
 * @see docs/adr/70-react-loop-mapping.md — think() → ReAct Thought
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md — think 是唯一的 Cognitive 原语
 */
function extractThinks(script: string): string[] {
  const thinks: string[] = [];
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    // 跳过 shebang、空注释、纯 section 分隔符
    if (trimmed.startsWith("#!")) continue;
    if (trimmed === "#") continue;
    if (/^#+$/.test(trimmed)) continue;
    if (trimmed.startsWith("# ")) {
      thinks.push(trimmed.slice(2));
    }
  }
  return thinks;
}

function toEnvValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function buildContextEnv(contextVars?: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  if (!contextVars) return env;

  // 所有 contextVars 以 ALICE_CTX_ 前缀注入（如 ALICE_CTX_TARGET_CHAT）。
  // CLI 命令在 --to 省略时自动从 ALICE_CTX_TARGET_CHAT fallback。

  const chatName = toEnvValue(contextVars.CHAT_NAME);
  if (chatName) env.ALICE_CHAT_NAME = chatName;

  for (const [key, value] of Object.entries(contextVars)) {
    const rendered = toEnvValue(value);
    if (rendered == null) continue;
    env[`ALICE_CTX_${key}`] = rendered;
  }

  return env;
}

function parseObservationControlLine(line: string): ExecutionObservation | string {
  const payload = line.slice(OBSERVATION_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(payload);
    if (isExecutionObservation(parsed)) return parsed;
    return "invalid __ALICE_OBSERVATION__: expected {kind,source,text,enablesContinuation}";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `invalid __ALICE_OBSERVATION__: ${message}`;
  }
}

function parseErrorDetailControlLine(line: string): ScriptExecutionErrorDetail | string {
  const payload = line.slice(ERROR_DETAIL_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(payload);
    if (isScriptExecutionErrorDetail(parsed)) return parsed;
    return "invalid __ALICE_ERROR_DETAIL__: expected structured error detail";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `invalid __ALICE_ERROR_DETAIL__: ${message}`;
  }
}

export async function executeShellScript(
  script: string,
  opts: { contextVars?: Record<string, unknown> },
): Promise<ScriptExecutionResult> {
  const startedAt = Date.now();
  const processed = preprocessScript(script);
  const result: ScriptExecutionResult = {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    errorDetails: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions: [],
    silenceReason: null,
  };

  // 从脚本源码提取 # 注释作为认知轨迹（thinks）。
  // 在执行前提取——即使脚本后续失败，思考过程仍被记录。
  result.thinks = extractThinks(processed);

  if (!processed) {
    result.errors.push("Empty shell script");
    result.duration = Date.now() - startedAt;
    return result;
  }

  const validation = validateScript(processed);
  if (!validation.valid) {
    result.instructionErrors.push(
      ...validation.errors.map((err) => `line ${err.line}: ${err.message}`),
    );
    result.errorCodes.push("script_validation");
    result.duration = Date.now() - startedAt;
    return result;
  }

  const env = buildInstalledSkillEnv({
    skillName: "alice-system",
    // ALICE_ENGINE_URL 由 docker.ts buildDockerExecConfig 统一注入
    // （通过 host.docker.internal:PORT）。
    extraEnv: buildContextEnv(opts.contextVars),
  });

  const execResult = await executeInContainer(`set -e\n${processed}`, env);

  // 中心化清洗：在数据入口点一处清洗，全链路受益
  const cleanStdout = sanitizeForLLM(execResult.stdout);
  const cleanStderr = sanitizeForLLM(execResult.stderr);

  const stdoutLines = cleanStdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const visibleStdout = stdoutLines.filter((line) => {
    if (line.startsWith(ACTION_PREFIX)) {
      result.completedActions.push(line.slice(ACTION_PREFIX.length));
      return false; // 过滤掉，不进入 visible logs
    }
    if (line.startsWith(OBSERVATION_PREFIX)) {
      const observation = parseObservationControlLine(line);
      if (typeof observation === "string") {
        result.instructionErrors.push(observation);
      } else {
        result.observations.push(observation);
      }
      return false;
    }
    return true;
  });
  if (visibleStdout.length > 0) {
    result.logs.push(...visibleStdout);
  }

  const stderrLines = cleanStderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const visibleStderr = stderrLines.filter((line) => {
    if (line.startsWith(ERROR_DETAIL_PREFIX)) {
      const detail = parseErrorDetailControlLine(line);
      if (typeof detail === "string") {
        result.instructionErrors.push(detail);
      } else {
        result.errorDetails?.push(detail);
      }
      return false;
    }
    if (line.startsWith(ERROR_PREFIX)) {
      const code = line.slice(ERROR_PREFIX.length);
      if (isScriptExecutionErrorCode(code)) result.errorCodes.push(code);
      return false;
    }
    return true;
  });
  if (visibleStderr.length > 0) {
    result.errors.push(visibleStderr.join("\n"));
  }
  if (execResult.code !== 0 && visibleStderr.length === 0) {
    result.errors.push(`Shell exited with status ${execResult.code}`);
    result.errorCodes.push("shell_nonzero");
  }

  result.duration = Date.now() - startedAt;
  log.debug("Executed shell script", {
    duration: result.duration,
    stdoutLines: visibleStdout.length,
    stderr: result.errors.length,
  });
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Execution backends
// ═══════════════════════════════════════════════════════════════════════════

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Container-isolated execution via Docker.
 *
 * 挂载宿主的 Alice 命令空间到容器内对应路径，使 LLM 脚本在容器中
 * 也能访问所有系统命令和已安装 Skill。
 *
 * TCP 通信不依赖 socket 挂载 → 所有容器统一使用 gVisor (sandboxed)。
 */
function executeInContainer(script: string, env: Record<string, string>): Promise<ExecResult> {
  return executeAliceSandboxProcess({
    command: script,
    image: DEFAULT_DOCKER_IMAGE,
    enginePort: _enginePort,
    skillName: "alice-system",
    network: true,
    memory: "1g",
    timeout: 35,
    env,
    includeAliceHome: true,
  });
}
