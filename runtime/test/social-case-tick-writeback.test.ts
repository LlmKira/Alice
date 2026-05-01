import type { execFile } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { setEnginePort } from "../src/core/shell-executor.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { listSocialEventsForRelation, writeSocialEvent } from "../src/db/social-case.js";
import { createBlackboard } from "../src/engine/tick/blackboard.js";
import { callTickLLM } from "../src/engine/tick/callLLM.js";
import { type TickDeps, tick } from "../src/engine/tick/tick.js";
import { startEngineApi } from "../src/engine-api/server.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";
import type { SocialEvent } from "../src/social-case/types.js";

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;
type ExecFileOptions = Parameters<typeof execFile>[2];

const ALICE = "alice";
const A = "contact:42";
const GROUP = "channel:-1001";
const VISIBLE_CASE_ID = "case:visible-public-insult";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

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

const { generateText } = await import("ai");

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  G.addContact(A, { display_name: "A", tier: 50 });
  G.addChannel(GROUP, { chat_type: "supergroup", display_name: "技术群" });
  G.addRelation(GROUP, "joined", A);
  return G;
}

function event(
  overrides: Partial<SocialEvent> & Pick<SocialEvent, "id" | "kind" | "occurredAtMs">,
): SocialEvent {
  return {
    actorId: A,
    targetId: ALICE,
    affectedRelation: [ALICE, A],
    venueId: GROUP,
    visibility: "public",
    witnesses: [],
    severity: 0.8,
    confidence: 0.95,
    evidenceMsgIds: [1001],
    caseId: VISIBLE_CASE_ID,
    ...overrides,
  };
}

function addOpenCaseFacts(): void {
  writeSocialEvent(
    event({
      id: "e1",
      kind: "insult",
      occurredAtMs: 1,
      text: "Alice 你真的很蠢，别装懂了.",
      causes: [
        {
          kind: "social_meaning",
          text: "This was public, named Alice directly, and attacked ability rather than the topic.",
          visibility: "public",
        },
      ],
    }),
  );
}

describe("ADR-262 social case tick writeback path", () => {
  beforeEach(() => {
    initDb(":memory:");
    vi.mocked(generateText).mockReset();
  });
  afterEach(() => {
    setEnginePort(0);
    closeDb();
  });

  it("carries prompt-built case handles through blackboard, fake LLM, shell executor, Engine, and DB", async () => {
    const G = makeGraph();
    addOpenCaseFacts();
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
    const selectedProvider = {
      provider: vi.fn((model: string) => ({ model })),
      model: "test-model",
      name: "test-provider",
    };

    const board = createBlackboard({
      pressures: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      voice: "conversation",
      target: GROUP,
      features: {
        hasWeather: true,
        hasMusic: false,
        hasBrowser: false,
        hasTTS: false,
        hasStickers: false,
        hasBots: false,
        hasSystemThreads: false,
        hasVideo: false,
      },
      contextVars: {},
      maxSteps: 1,
    });

    vi.mocked(generateText).mockImplementation(async () => {
      const handle = board.contextVars.SOCIAL_CASE_0_HANDLE;
      if (typeof handle !== "string") {
        throw new Error("expected prompt builder to install hidden social case handle");
      }
      return {
        text: JSON.stringify({
          script: [
            "# A repeated the same insult after the repaired case.",
            `self social-case-note --kind boundary_violation --other "${A}" --venue "技术群" --visibility public --text "Alice 你还是很蠢。" --case "${handle}"`,
          ].join("\n"),
          afterward: "done",
        }),
      } as never;
    });

    const deps: TickDeps = {
      callLLM: (system, user, tickNo, target, voice, contextVars) =>
        callTickLLM(system, user, tickNo, target, voice, contextVars, selectedProvider as never),
    };

    try {
      const result = await tick(board, [], deps, {
        G,
        dispatcher,
        mods: dispatcher.mods,
        config: {
          timezoneOffset: 8,
          exaApiKey: "",
          musicApiBaseUrl: "",
          peripheral: { perChannelCap: 3, totalCap: 5, minTextLength: 10 },
        },
        item: {
          enqueueTick: 42,
          action: "sociability",
          target: GROUP,
          pressureSnapshot: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
          contributions: {},
          facetId: "core",
        },
        tick: 42,
        messages: [],
        observations: [],
        round: 0,
        client: null,
        runtimeConfig: {} as never,
      });

      expect(result.outcome).toBe("terminal");
      expect(result.execution.errors).toEqual([]);
      expect(result.execution.thinks).toEqual([
        "A repeated the same insult after the repaired case.",
      ]);
      expect(result.execution.logs).toContain("success: true");
      expect(result.tcMeta?.commandLog).toContain("--case");
      expect(board.contextVars.SOCIAL_CASE_0_ID).toBe(VISIBLE_CASE_ID);
      expect(
        listSocialEventsForRelation([ALICE, A]).map((socialEvent) => ({
          caseId: socialEvent.caseId,
          kind: socialEvent.kind,
        })),
      ).toEqual([
        { caseId: VISIBLE_CASE_ID, kind: "insult" },
        { caseId: VISIBLE_CASE_ID, kind: "boundary_violation" },
      ]);
    } finally {
      await server.cleanup();
    }
  });
});
