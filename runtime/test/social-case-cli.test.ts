import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation } from "../src/db/social-case.js";
import { startEngineApi } from "../src/engine-api/server.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";

const execFileAsync = promisify(execFile);
const VISIBLE_CASE_ID = "case:visible-public-insult";
const VISIBLE_CASE_HANDLE = "firm-repair";

interface CliRun {
  stderr: string;
  stdout: string;
}

async function runSelfCli(
  port: number,
  args: readonly string[],
  context: Record<string, string> = {},
): Promise<CliRun> {
  const { stderr, stdout } = await execFileAsync(
    "./node_modules/.bin/tsx",
    ["skills/system-bin/self.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ALICE_ENGINE_URL: `http://127.0.0.1:${port}`,
        ALICE_SKILL: "alice-system",
        ...Object.fromEntries(
          Object.entries(context).map(([key, value]) => [`ALICE_CTX_${key}`, value]),
        ),
      },
      timeout: 10_000,
    },
  );
  return { stderr: stderr.trim(), stdout: stdout.trim() };
}

async function runSelfCliFailure(
  port: number,
  args: readonly string[],
  context: Record<string, string> = {},
): Promise<CliRun> {
  try {
    await runSelfCli(port, args, context);
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return {
      stderr: (failure.stderr ?? "").trim(),
      stdout: (failure.stdout ?? "").trim(),
    };
  }
  throw new Error("expected self CLI command to fail");
}

describe("ADR-262 social case self CLI", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("writes a prompt-visible case handle through the real self CLI and Engine /cmd path", async () => {
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

    try {
      const first = await runSelfCli(
        server.port,
        [
          "social-case-note",
          "--kind",
          "insult",
          "--other",
          "contact:A",
          "--venue",
          "技术群",
          "--visibility",
          "public",
          "--text",
          "Alice 你真的很蠢，别装懂了.",
        ],
        {
          CURRENT_SOCIAL_CASE_ID: VISIBLE_CASE_ID,
          CURRENT_SOCIAL_CASE_HANDLE: VISIBLE_CASE_HANDLE,
        },
      );
      expect(first.stdout).toContain("success: true");

      const second = await runSelfCliFailure(server.port, [
        "social-case-note",
        "--kind",
        "boundary_violation",
        "--other",
        "contact:A",
        "--venue",
        "技术群",
        "--visibility",
        "public",
        "--text",
        "Alice 你还是很蠢。",
        "--case",
        VISIBLE_CASE_HANDLE,
      ]);
      expect(second.stderr).toContain("case handle is not available");

      const withContext = await runSelfCli(
        server.port,
        [
          "social-case-note",
          "--kind",
          "boundary_violation",
          "--other",
          "contact:A",
          "--venue",
          "技术群",
          "--visibility",
          "public",
          "--text",
          "Alice 你还是很蠢。",
          "--case",
          VISIBLE_CASE_HANDLE,
        ],
        {
          SOCIAL_CASE_0_HANDLE: VISIBLE_CASE_HANDLE,
          SOCIAL_CASE_0_ID: VISIBLE_CASE_ID,
        },
      );
      expect(withContext.stdout).toContain("success: true");
      expect(
        listSocialEventsForRelation(["alice", "contact:A"]).map((event) => event.caseId),
      ).toEqual([VISIBLE_CASE_ID, VISIBLE_CASE_ID]);
    } finally {
      await server.cleanup();
    }
  });
});
