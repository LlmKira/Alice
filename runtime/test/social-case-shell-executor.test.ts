import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation } from "../src/db/social-case.js";
import { startEngineApi } from "../src/engine-api/server.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;
type ExecFileOptions = Parameters<typeof import("node:child_process").execFile>[2];

const VISIBLE_CASE_ID = "case:visible-public-insult";
const VISIBLE_CASE_HANDLE = "firm-repair";

function dockerExecEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const sessionIdx = args.findIndex((arg) => arg.startsWith("alice-sbx-"));
  const end = sessionIdx >= 0 ? sessionIdx : args.length;

  for (let i = 1; i < end; i++) {
    if (args[i] !== "-e") continue;
    const assignment = args[i + 1] ?? "";
    const eq = assignment.indexOf("=");
    if (eq > 0) {
      env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    }
    i++;
  }

  return env;
}

function hostEnvFromDockerExec(args: string[]): Record<string, string> {
  const env = dockerExecEnv(args);
  const hostBin = resolve(process.cwd(), "dist/bin");
  if (env.PATH) env.PATH = env.PATH.replace("/opt/alice/bin", hostBin);
  if (env.ALICE_SYSTEM_BIN_DIR === "/opt/alice/bin") env.ALICE_SYSTEM_BIN_DIR = hostBin;
  if (env.ALICE_ENGINE_URL) {
    env.ALICE_ENGINE_URL = env.ALICE_ENGINE_URL.replace("host.docker.internal", "127.0.0.1");
  }
  return env;
}

// 用本机 /bin/sh 执行 Docker session 中的脚本，同时保留 docker -e 注入语义。
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: vi.fn((cmd: string, args: string[], opts: ExecFileOptions, cb: ExecFileCallback) => {
      if (cmd === "docker") {
        const sub = args[0];
        if (sub === "exec") {
          const shIdx = args.indexOf("/bin/sh");
          const script = shIdx >= 0 ? args[shIdx + 2] : args[args.length - 1];
          return original.execFile(
            "/bin/sh",
            ["-c", script],
            { ...opts, env: { ...process.env, ...hostEnvFromDockerExec(args) } },
            cb,
          );
        }
        cb(null, "", "");
        return;
      }
      return original.execFile(cmd, args, opts, cb);
    }),
  };
});

const { executeShellScript, setEnginePort } = await import("../src/core/shell-executor.js");

describe("ADR-262 social case shell executor path", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => {
    setEnginePort(0);
    closeDb();
  });

  it("writes prompt-visible case handles through generated shell script context vars", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const dispatcher = createAliceDispatcher({ graph: G, mods: [socialCaseMod] });
    dispatcher.startTick(42, 1_000_000);
    const server = await startEngineApi({
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      port: 0,
      strictCapabilities: false,
      dispatchInstruction: (name, args) => dispatcher.dispatch(name, args),
      query: (name, args) => dispatcher.query(name, args),
      resolveCommandKind: (name) => {
        if (dispatcher.getQueryDef(name)) return "query";
        if (dispatcher.getInstructionDef(name)) return "instruction";
        return undefined;
      },
      getMods: () => dispatcher.mods,
    });
    setEnginePort(server.port);

    try {
      const first = await executeShellScript(
        'self social-case-note --kind insult --other "contact:A" --venue "技术群" --visibility public --text "Alice 你真的很蠢，别装懂了."',
        {
          contextVars: {
            CURRENT_SOCIAL_CASE_ID: VISIBLE_CASE_ID,
            CURRENT_SOCIAL_CASE_HANDLE: VISIBLE_CASE_HANDLE,
          },
        },
      );
      expect(first.errors).toEqual([]);
      expect(first.logs).toContain("success: true");

      const failure = await executeShellScript(
        `self social-case-note --kind boundary_violation --other "contact:A" --venue "技术群" --visibility public --text "Alice 你还是很蠢。" --case "${VISIBLE_CASE_HANDLE}"`,
        {},
      );
      expect(failure.errors.join("\n")).toContain("case handle is not available");

      const withContext = await executeShellScript(
        [
          "# A repeated the same insult after the repaired case.",
          `self social-case-note --kind boundary_violation --other "contact:A" --venue "技术群" --visibility public --text "Alice 你还是很蠢。" --case "${VISIBLE_CASE_HANDLE}"`,
        ].join("\n"),
        {
          contextVars: {
            SOCIAL_CASE_0_HANDLE: VISIBLE_CASE_HANDLE,
            SOCIAL_CASE_0_ID: VISIBLE_CASE_ID,
          },
        },
      );
      expect(withContext.thinks).toEqual(["A repeated the same insult after the repaired case."]);
      expect(withContext.errors).toEqual([]);
      expect(withContext.logs).toContain("success: true");
      expect(
        listSocialEventsForRelation(["alice", "contact:A"]).map((event) => event.caseId),
      ).toEqual([VISIBLE_CASE_ID, VISIBLE_CASE_ID]);
    } finally {
      await server.cleanup();
    }
  });
});
