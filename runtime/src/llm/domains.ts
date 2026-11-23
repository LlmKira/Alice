/**
 * 执行层的领域（ADR-298 执行层）：一个领域是几样工具和怎么执行它们。执行代理（errand.ts）每件事只打开它要的
 * 那几个领域；日常聊天的提示词里一样也看不到。
 *
 * - web：搜索、打开网页、直接回答、天气、算日子（errand-tools.ts），一直都在；
 * - MCP 服务：按配置启动，只挂配置里列出的工具；
 * - shell：只跑配置里列出的命令，参数原样交给命令、不经 shell 解释，在指定目录里、有时限。
 *
 * 领域的结果都经 look_up 交回，算"外面的内容"：结果还在她眼前时退群、加群不可用（affordances.ts readOutside）。
 * 执行代理没有发消息、退群这类动作，也不知道她是谁。
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { ToolSpec } from "../speech/decision.js";
import { isToolName, runTool, TOOL_SPECS, type ToolDeps, type ToolOutput } from "./errand-tools.js";

export interface Domain {
  name: string;
  /** 一句话：能办什么（执行代理按它挑领域）。 */
  about: string;
  tools: readonly ToolSpec[];
  run: (tool: string, args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolOutput>;
}

const OUTPUT_CHARS = 3000;
const output = (text: string): ToolOutput => ({
  text: text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}…` : text,
  urls: [],
  usd: 0,
});

export const web: Domain = {
  name: "web",
  about: "the web: search, open a page, get a direct answer, weather, date arithmetic",
  tools: TOOL_SPECS.filter((t) => t.function.name !== "hand_back"),
  run: async (tool, args, deps) =>
    isToolName(tool) ? runTool(tool, args, deps) : output("No such tool."),
};

const MCP = z.object({
  name: z.string(),
  about: z.string(),
  mcp: z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    tools: z.array(z.string()),
  }),
});
const SHELL = z.object({
  name: z.string(),
  about: z.string(),
  shell: z.object({ cwd: z.string(), commands: z.array(z.string()).min(1) }),
});
const DESK = z.object({
  name: z.string(),
  about: z.string(),
  desk: z.object({ dir: z.string() }),
});
const CONFIG = z.array(z.union([MCP, SHELL, DESK]));
const CONTENT = z.array(z.object({ type: z.string(), text: z.string().optional() }));

/** 一个 MCP 服务：启动它，只把配置里列出的工具挂出来。 */
async function mcpDomain({ name, about, mcp }: z.infer<typeof MCP>): Promise<Domain> {
  const client = new Client({ name: "alice-executor", version: "1" });
  await client.connect(new StdioClientTransport({ command: mcp.command, args: mcp.args }));
  const { tools } = await client.listTools();
  return {
    name,
    about,
    tools: tools
      .filter((t) => mcp.tools.includes(t.name))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
      })),
    run: async (tool, args) => {
      if (!mcp.tools.includes(tool)) return output("No such tool.");
      const result = await client.callTool({ name: tool, arguments: args });
      return output(
        CONTENT.parse(result.content)
          .map((p) => p.text ?? `[${p.type}]`)
          .join("\n"),
      );
    },
  };
}

const execFileAsync = promisify(execFile);

function shellDomain({ name, about, shell }: z.infer<typeof SHELL>): Domain {
  const call = z.object({
    command: z.string().refine((c) => shell.commands.includes(c), "not an allowed command"),
    args: z.array(z.string()).default([]),
  });
  return {
    name,
    about,
    tools: [
      {
        type: "function",
        function: {
          name: "run_command",
          description: `Run one command in the working directory. Allowed: ${shell.commands.join(", ")}`,
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", enum: shell.commands },
              args: { type: "array", items: { type: "string" } },
            },
            required: ["command"],
          },
        },
      },
    ],
    run: async (_tool, raw, deps) => {
      const parsed = call.safeParse(raw);
      if (!parsed.success)
        return output(`Failed: ${parsed.error.issues[0]?.message ?? "bad arguments"}`);
      try {
        const { command, args } = parsed.data;
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: shell.cwd,
          timeout: deps.timeoutMs,
        });
        return output(stdout || stderr);
      } catch (error) {
        return output(`Failed: ${String(error)}`);
      }
    },
  };
}

const MAX_NOTE_BYTES = 16 * 1024;
const NOTE_PATH = z.object({ path: z.string().min(1) });
const NOTE_WRITE = z.object({ path: z.string().min(1), content: z.string() });

function resolveInDesk(root: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  const diff = relative(base, full);
  if (!diff || diff.startsWith("..") || isAbsolute(diff)) return null;
  return full;
}

async function listDeskNotes(root: string, prefix = ""): Promise<string[]> {
  const dir = prefix ? resolve(root, prefix) : resolve(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await listDeskNotes(root, rel)));
    } else if (entry.isFile()) {
      const info = await stat(resolve(root, rel)).catch(() => null);
      results.push(info ? `${rel} (${info.size}B)` : rel);
    }
  }
  return results.sort();
}

const DESK_TOOLS: readonly ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List notes and bookmarks saved in Alice's personal desk workspace",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read one note from Alice's personal desk workspace",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path, e.g. music.md" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_note",
      description: "Create or overwrite a note in Alice's personal desk workspace (max 16 KB)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. reading/notes.md" },
          content: { type: "string", description: "Full note content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_note",
      description: "Append a line or entry to a note in Alice's personal desk workspace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. bookmarks.md" },
          content: { type: "string", description: "Text to append" },
        },
        required: ["path", "content"],
      },
    },
  },
];

async function readDeskNote(root: string, raw: Record<string, unknown>): Promise<ToolOutput> {
  const parsed = NOTE_PATH.safeParse(raw);
  if (!parsed.success) return output("Failed: path is required");
  const full = resolveInDesk(root, parsed.data.path);
  if (!full) return output("Failed: path escapes desk workspace");
  const content = await readFile(full, "utf8").catch(() => null);
  return output(content === null ? "Not found." : content);
}

async function saveDeskNote(
  root: string,
  raw: Record<string, unknown>,
  append: boolean,
): Promise<ToolOutput> {
  const parsed = NOTE_WRITE.safeParse(raw);
  if (!parsed.success) return output("Failed: path and content are required");
  const full = resolveInDesk(root, parsed.data.path);
  if (!full) return output("Failed: path escapes desk workspace");
  const bytes = Buffer.byteLength(parsed.data.content, "utf8");
  if (bytes > MAX_NOTE_BYTES) return output("Failed: note exceeds 16 KB limit");
  await mkdir(dirname(full), { recursive: true });
  if (!append) {
    await writeFile(full, parsed.data.content, "utf8");
    return output(`Saved ${parsed.data.path} (${bytes}B).`);
  }
  const existing = await stat(full).catch(() => null);
  if ((existing?.size ?? 0) + bytes + 1 > MAX_NOTE_BYTES) {
    return output("Failed: note would exceed 16 KB limit");
  }
  const prefix = existing && existing.size > 0 ? "\n" : "";
  await appendFile(full, `${prefix}${parsed.data.content}`, "utf8");
  return output(`Appended to ${parsed.data.path}.`);
}

/** 她自己的轻量桌面空间（笔记、收藏、草稿）：严格锚定在指定目录，防路径穿越。 */
function deskDomain({ name, about, desk }: z.infer<typeof DESK>): Domain {
  const root = resolve(desk.dir);
  return {
    name,
    about,
    tools: DESK_TOOLS,
    run: async (tool, raw) => {
      if (tool === "list_notes") {
        const files = await listDeskNotes(root);
        return output(files.length > 0 ? files.join("\n") : "(empty desk)");
      }
      if (tool === "read_note") return readDeskNote(root, raw);
      if (tool === "write_note") return saveDeskNote(root, raw, false);
      if (tool === "append_note") return saveDeskNote(root, raw, true);
      return output("No such tool.");
    },
  };
}

/** 读取她个人桌面里最近修改的几篇笔记标题和首行摘要，供每日生活/做梦自然承接。 */
export async function summarizeDeskNotes(dir: string, limit = 5): Promise<string[]> {
  const root = resolve(dir);
  const files: Array<{ rel: string; mtimeMs: number }> = [];
  const walk = async (prefix: string): Promise<void> => {
    const cur = prefix ? resolve(root, prefix) : root;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        const info = await stat(resolve(root, rel)).catch(() => null);
        if (info) files.push({ rel, mtimeMs: info.mtimeMs });
      }
    }
  };
  await walk("");
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const summaries: string[] = [];
  for (const f of files.slice(0, limit)) {
    const raw = await readFile(resolve(root, f.rel), "utf8").catch(() => "");
    const first = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    summaries.push(first ? `${f.rel}: ${first.slice(0, 80)}` : f.rel);
  }
  return summaries;
}

const HAND_BACK = TOOL_SPECS.filter((t) => t.function.name === "hand_back");

/**
 * 一件事的工具箱：只有一个领域时直接打开（和只有 web 时逐字节一样）；不止一个时先只给 use，
 * 执行代理打开这件事要的那几类，才看得到那几类的工具。
 */
export class Toolbox {
  private readonly open: Domain[];

  constructor(private readonly domains: readonly Domain[]) {
    this.open = domains.length > 1 ? [] : [...domains];
  }

  /** 系统提示里补的一句（只有一个领域时不补）。 */
  get note(): string {
    return this.domains.length > 1 ? "\nTo use a kind of tool, open it with use first." : "";
  }

  /** 此刻的工具；final 时只剩交回。 */
  tools(final: boolean): readonly ToolSpec[] {
    if (final) return HAND_BACK;
    const closed = this.domains.filter((d) => !this.open.includes(d));
    return [
      ...this.open.flatMap((d) => d.tools),
      ...(closed.length > 0 ? [useSpec(closed)] : []),
      ...HAND_BACK,
    ];
  }

  async run(tool: string, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutput> {
    if (tool === "use") {
      const domain = this.domains.find((d) => d.name === args.domain);
      if (!domain) return output("No such domain.");
      if (!this.open.includes(domain)) this.open.push(domain);
      return output(
        `Opened ${domain.name}: ${domain.tools.map((t) => t.function.name).join(", ")}`,
      );
    }
    const domain = this.open.find((d) => d.tools.some((t) => t.function.name === tool));
    return domain ? domain.run(tool, args, deps) : output("No such tool.");
  }
}

function useSpec(closed: readonly Domain[]): ToolSpec {
  return {
    type: "function",
    function: {
      name: "use",
      description: `Open one kind of tool: ${closed.map((d) => `${d.name} (${d.about})`).join("; ")}`,
      parameters: {
        type: "object",
        properties: { domain: { type: "string", enum: closed.map((d) => d.name) } },
        required: ["domain"],
      },
    },
  };
}

/** web 加上操作员配置的领域（ALICE_EXECUTOR_DOMAINS 指向的 JSON）。 */
export async function loadDomains(path: string | null): Promise<Domain[]> {
  if (path === null) return [web];
  const entries = CONFIG.parse(JSON.parse(await readFile(path, "utf8")));
  const extra = await Promise.all(
    entries.map(async (e) =>
      "mcp" in e ? mcpDomain(e) : "shell" in e ? shellDomain(e) : deskDomain(e),
    ),
  );
  return [web, ...extra];
}
