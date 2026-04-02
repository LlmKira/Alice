/**
 * self — 统一认知 CLI（感知 + 记忆 + 观察 + 查询）。
 *
 * ADR-217: 合并原 engine CLI。所有非 irc 操作统一走 self。
 * 路由：`self <kebab-cmd> [key=value ...]` → POST /cmd/<snake_cmd>
 * Engine 侧自动区分 query 和 instruction——CLI 无需关心。
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { defineCommand, runMain } from "citty";
import {
  enginePostJson,
  extractJsonFlag,
  parseKeyValueArgs,
  renderBridgeResult,
  renderHuman,
} from "../../src/system/cli-bridge.ts";

/** kebab-case → snake_case。 */
function toSnake(kebab: string): string {
  return kebab.replace(/-/g, "_");
}

/**
 * 自定义 --help：拉取 /meta/commands 端点生成分组帮助。
 * 降级：引擎不可用时打印最小帮助。
 */
async function printHelp(): Promise<void> {
  console.log("self — perception, memory, and bookkeeping\n");
  console.log("USAGE: self <command> [key=value ...]\n");

  try {
    const response = (await enginePostJson("/meta/commands", {})) as {
      commands?: Array<{
        name: string;
        kind: string;
        description: string;
        params: Array<{ name: string; optional: boolean }>;
      }>;
    };

    const cmds = response.commands ?? [];
    if (cmds.length === 0) {
      console.log("  (no commands available — engine may not be running)");
      return;
    }

    // 按 kind 分组
    const instructions = cmds.filter((c) => c.kind === "instruction");
    const queries = cmds.filter((c) => c.kind === "query");

    const renderCmd = (c: (typeof cmds)[0]) => {
      const cliName = c.name.replace(/_/g, "-");
      const params = c.params.map((p) => (p.optional ? `[${p.name}=...]` : `${p.name}=...`)).join(" ");
      const sig = params ? `${cliName} ${params}` : cliName;
      console.log(`  ${sig.padEnd(44)} ${c.description}`);
    };

    if (instructions.length > 0) {
      console.log("COMMANDS:");
      for (const c of instructions) renderCmd(c);
      console.log();
    }

    if (queries.length > 0) {
      console.log("QUERIES:");
      for (const c of queries) renderCmd(c);
      console.log();
    }
  } catch {
    console.log("  (cannot reach engine — run with engine active for full help)");
    console.log();
  }

  console.log('Use "self <command> --help" for details.');
  console.log('Use "--json" flag for raw JSON output.');
}

const main = defineCommand({
  meta: {
    name: "self",
    description: "Perception, memory, and bookkeeping",
  },
  args: {
    command: {
      type: "positional",
      description: "Command or query name (e.g. feel, diary, note, pressure, reminders)",
      required: false,
    },
  },
  async run({ args, rawArgs }) {
    // --help 或无参数 → 打印帮助
    if (!args.command || rawArgs.includes("--help") || rawArgs.includes("-h")) {
      await printHelp();
      return;
    }

    const { json, args: cleaned } = extractJsonFlag(rawArgs);

    const cmd = args.command as string;
    // kebab→snake：`begin-topic` → `begin_topic`
    const snakeCmd = toSnake(cmd);

    // rawArgs 第一个是 command，其余是 key=value 参数
    const kvArgs = cleaned.slice(1).filter((a) => a !== "--help" && a !== "-h");
    const body = parseKeyValueArgs(kvArgs);

    // ADR-217: 统一端点，Engine 侧区分 query/instruction
    const response = (await enginePostJson(`/cmd/${snakeCmd}`, body)) as {
      result?: unknown;
    };

    // ADR-235: 默认人类可读，--json 保留原始格式
    if (json) {
      console.log(renderBridgeResult(response.result));
    } else {
      console.log(renderHuman(response.result));
    }
  },
});

runMain(main);
