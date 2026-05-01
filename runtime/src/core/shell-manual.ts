/**
 * Shell-native manual generator.
 *
 * ADR-217: 统一 self 命名空间 + irc 子命令签名。
 * 唯一事实来源：Mod definitions (指令/查询) + irc citty definitions (子命令)。
 */

import type { z } from "zod";
import { albumSubCommands } from "../system/album-cli.js";
import { alicePkgSubCommands } from "../system/alice-pkg-cli.js";
import { renderSubCommandSynopsis } from "../system/citty-synopsis.js";
import { ircSubCommands } from "../system/irc-cli.js";
import { probeCommandCatalog } from "./command-catalog.js";
import { registerKnownCommands, registerKnownSubcommands } from "./script-validator.js";
import type { ModDefinition, ParamDefinition } from "./types.js";

function isOptionalParam(param: ParamDefinition): boolean {
  return param.schema.isOptional();
}

/** snake_case → kebab-case for CLI display. */
function toKebab(snake: string): string {
  return snake.replace(/_/g, "-");
}

const MANUAL_OMIT_ARGS = new Set(["json"]);

function renderIrcSection(): string[] {
  registerKnownSubcommands("irc", Object.keys(ircSubCommands));
  const lines = [
    "## irc",
    "",
    "Named flags only. Omit `--in` for this chat; never write `--in current`.",
    "Reaction emoji must be Telegram-supported, for example: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 😢 🎉 👀 😴.",
    "When you don't know who someone is or what's going on, a quick lookup (`irc whois`, `irc threads`) fills you in instantly.",
    "",
    ...renderSubCommandSynopsis("irc", ircSubCommands, { omitArgs: MANUAL_OMIT_ARGS }),
  ];
  lines.push("");
  return lines;
}

// ─── self 指令/查询渲染 ──────────────────────────────────────────────
// POSIX synopsis 风格：一行一个命令，<required> [optional] a|b|c=枚举。

/**
 * 从 zod schema 提取枚举值列表。
 * 支持 z.enum / z.default(z.enum) / z.optional(z.enum)。
 * 返回 null 表示非枚举。
 */
function extractEnumValues(schema: z.ZodTypeAny): string[] | null {
  const typeName = (schema._def as { typeName?: string }).typeName;
  if (!typeName) return null;

  if (typeName === "ZodEnum") {
    const values = (schema._def as { values?: unknown }).values;
    return Array.isArray(values) ? (values as string[]) : null;
  }
  if (typeName === "ZodDefault" || typeName === "ZodOptional") {
    const inner = (schema._def as { innerType?: z.ZodTypeAny }).innerType;
    return inner ? extractEnumValues(inner) : null;
  }
  return null;
}

/** 生成参数的值占位符：枚举用 <a|b|c>，其余用 <name>。 */
function paramPlaceholder(paramName: string, schema: z.ZodTypeAny): string {
  const enumValues = extractEnumValues(schema);
  if (enumValues && enumValues.length <= 10) {
    return `<${enumValues.join("|")}>`;
  }
  return `<${paramName}>`;
}

function renderSelfCommands(mods: readonly ModDefinition[]): string[] {
  const lines: string[] = ["## self", ""];
  const subcommands: string[] = [];

  for (const mod of mods) {
    const instructionEntries = Object.entries(mod.instructions ?? {}).filter(
      ([, def]) => def.affordance != null,
    );
    const queryEntries = Object.entries(mod.queries ?? {}).filter(
      ([, def]) => def.affordance != null,
    );

    for (const [name, def] of instructionEntries) {
      subcommands.push(toKebab(name));
      const derivedKeys = def.deriveParams
        ? new Set(Object.keys(def.deriveParams))
        : new Set<string>();
      const parts: string[] = [`self ${toKebab(name)}`];
      for (const [paramName, param] of Object.entries(def.params)) {
        if (derivedKeys.has(paramName)) continue;
        const optional = isOptionalParam(param);
        const placeholder = paramPlaceholder(paramName, param.schema);
        const flag = `--${paramName} ${placeholder}`;
        parts.push(optional ? `[${flag}]` : flag);
      }
      lines.push(parts.join(" "));
    }

    for (const [name, def] of queryEntries) {
      subcommands.push(toKebab(name));
      const derivedKeys = def.deriveParams
        ? new Set(Object.keys(def.deriveParams))
        : new Set<string>();
      const parts: string[] = [`self ${toKebab(name)}`];
      for (const [paramName, param] of Object.entries(def.params)) {
        if (derivedKeys.has(paramName)) continue;
        const optional = isOptionalParam(param);
        const placeholder = paramPlaceholder(paramName, param.schema);
        const flag = `--${paramName} ${placeholder}`;
        parts.push(optional ? `[${flag}]` : flag);
      }
      lines.push(parts.join(" "));
    }
  }

  registerKnownSubcommands("self", subcommands);
  lines.push("");
  return lines;
}

// ─── Command Catalog（系统命令 + Skill 命令发现）──────────────────────

function renderAlicePkgSection(): string[] {
  registerKnownSubcommands("alice-pkg", Object.keys(alicePkgSubCommands));
  const lines = ["## alice-pkg", "", ...renderSubCommandSynopsis("alice-pkg", alicePkgSubCommands)];
  lines.push("");
  return lines;
}

function renderAlbumSection(): string[] {
  registerKnownSubcommands("album", Object.keys(albumSubCommands));
  const lines = [
    "## album",
    "",
    "Search and send group photos Alice has already observed. Sending is current-chat scoped.",
    "Search index fields: caption text, VLM/WDTagger description, OCR text, and tags. Current photo descriptions are usually English prose; OCR is raw/noisy text from screenshots and memes.",
    'For ordinary image requests, search short visual English terms first: object + scene/color/action, for example `album search --query "kitten laptop" --count 5` or `album search --query "rocket fire smoke" --count 5`.',
    // @see docs/adr/260-group-photo-album-affordance/README.md
    // @see docs/adr/266-tool-result-action-closure/README.md
    'When someone asks for a picture, search the group photo album before saying you cannot send one: `album search --query "visual words" --count 5`, then `album send --asset <assetId>` if a result fits.',
    "For text-in-image requests, search exact visible words or distinctive OCR fragments. Use 1-3 short variants rather than a full sentence, because OCR may merge spaces or misread Cyrillic/Latin-looking letters.",
    "If the user asks in another language, translate the visual target into likely English description words before searching; then inspect `description`/`ocrText` with `--json` and retry narrower or broader.",
    "Do not use `--include-unavailable` for normal sends. It is only for diagnosing photos whose source message was deleted or became inaccessible.",
    "",
    ...renderSubCommandSynopsis("album", albumSubCommands, { omitArgs: MANUAL_OMIT_ARGS }),
  ];
  lines.push("");
  return lines;
}

// ─── Skill 命令（外部二进制，参数各异，用 --help 查看）──────────────

async function renderSkillCatalog(): Promise<string[]> {
  const catalog = await probeCommandCatalog();
  registerKnownCommands(catalog.commands.map((c) => c.name));
  const lines: string[] = [];

  const skillCommands = catalog.commands.filter((entry) => entry.kind === "skill");

  if (skillCommands.length > 0) {
    lines.push("## Skills on PATH (use <command> --help for details)", "");
    for (const entry of skillCommands) {
      const hint = entry.whenToUse ? ` | ${entry.whenToUse}` : "";
      lines.push(`${entry.name} — ${entry.summary}${hint}`);
    }
    lines.push("");
  }

  return lines;
}

// ─── 入口 ────────────────────────────────────────────────────────────

export async function generateShellManual(mods: readonly ModDefinition[]): Promise<string> {
  const skillCatalog = await renderSkillCatalog();
  const parts = [
    "## Shell Contract",
    "",
    'Return only one JSON object: {"script":"...","afterward":"done|waiting_reply|watching|resting|fed_up|cooling_down","residue":{...}}.',
    "The JSON `script` value is a multi-line POSIX sh script. One command per line. `# ...` comments = inner monologue.",
    "If you choose silence/no action, return a script with only `# ...` comments, for example `# nothing to add`.",
    "Omit `residue` unless something feels unfinished.",
    "All commands support --help.",
    "`<command> --help` opens detailed usage for specialized tools. But most of the time you don't need any of this — just talk.",
    "Do not invent aliases or positional shorthand. For `irc`, use named flags exactly as shown below.",
    "Prefer double quotes for flag values. Avoid single-quoting natural language.",
    "Do not parse CLI output with shell tools to get message IDs. Use visible numeric `msgId` values from the chat context, for example `--ref 12099`.",
    "Batch pure reads in one script before you act. Split queries across multiple turns only when one result changes the next question.",
    "",
    "## Afterward",
    "",
    "`done` | `waiting_reply` | `watching` | `resting` (sleep/leaves Telegram) | `fed_up` (closes chat) | `cooling_down` (freezes ~30min)",
    "These are post-turn chat signals. Immediate same-tick follow-up is host-controlled from fresh observations.",
    "",
    ...renderIrcSection(),
    ...renderAlbumSection(),
    ...renderSelfCommands(mods),
    ...renderAlicePkgSection(),
    ...skillCatalog,
  ];

  return parts.join("\n");
}
