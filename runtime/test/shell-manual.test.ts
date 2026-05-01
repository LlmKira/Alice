import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeCommandCatalog } from "../src/core/command-catalog.js";
import { generateShellManual } from "../src/core/shell-manual.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";
import { ALICE_CONTAINER_PATHS } from "../src/skills/container-runner.js";
import type { Registry } from "../src/skills/registry.js";

vi.mock("../src/skills/backends/docker.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skills/backends/docker.js")>();
  return {
    ...original,
    executeDockerCommand: vi.fn(),
  };
});

describe("command catalog", () => {
  it("probes command visibility via container and builds the catalog", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockResolvedValue("irc\nctl\nweather\n");

    const root = mkdtempSync(join(tmpdir(), "alice-catalog-"));
    const systemBinDir = join(root, "system-bin");
    const storePath = join(root, "store-weather");

    mkdirSync(systemBinDir, { recursive: true });
    mkdirSync(storePath, { recursive: true });

    writeFileSync(join(systemBinDir, "irc"), "#!/usr/bin/env sh\n");
    writeFileSync(join(systemBinDir, "ctl"), "#!/usr/bin/env sh\n");
    chmodSync(join(systemBinDir, "irc"), 0o755);
    chmodSync(join(systemBinDir, "ctl"), 0o755);
    writeFileSync(join(systemBinDir, "irc.ts"), "ignored source");

    writeFileSync(
      join(storePath, "manifest.yaml"),
      [
        "name: weather",
        'version: "1.1.0"',
        'description: "Weather forecast — global coverage"',
        "actions:",
        "  - name: use_weather_app",
        '    description: ["Check weather"]',
        '    whenToUse: "Check weather"',
      ].join("\n"),
    );
    writeFileSync(join(storePath, "weather"), "#!/usr/bin/env sh\n");
    chmodSync(join(storePath, "weather"), 0o755);
    symlinkSync(join(storePath, "weather"), join(systemBinDir, "weather"));

    const registry: Registry = {
      "alice-system": {
        name: "alice-system",
        version: "1.0.0",
        hash: "builtin-system",
        storePath: systemBinDir,
        commandPath: join(systemBinDir, "irc"),
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["irc", "ctl"],
        categories: ["app"],
        capabilities: [],
        backend: "shell",
      },
      weather: {
        name: "weather",
        version: "1.1.0",
        hash: "hash-weather",
        storePath,
        commandPath: join(storePath, "weather"),
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["use_weather_app"],
        categories: ["weather"],
        capabilities: [],
        backend: "shell",
      },
    };

    const catalog = await probeCommandCatalog({
      registry,
      systemBinDir,
      env: {
        PATH: `${systemBinDir}:${process.env.PATH ?? ""}`,
        ALICE_SYSTEM_BIN_DIR: systemBinDir,
      },
    });

    expect(catalog.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "irc",
          kind: "system",
          summary: "Telegram system chat client for Alice",
        }),
        expect.objectContaining({
          name: "weather",
          kind: "skill",
          summary: expect.stringContaining("Weather"),
        }),
      ]),
    );
    expect(catalog.commands.filter((entry) => entry.name === "weather")).toHaveLength(1);
  });
});

describe("generateShellManual", () => {
  it("renders native citty synopsis for irc and alice-pkg", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockResolvedValue("irc\nself\nengine\nask\nalice-pkg\n");

    const manual = await generateShellManual([]);

    expect(manual).toContain(
      'Return only one JSON object: {"script":"...","afterward":"done|waiting_reply|watching|resting|fed_up|cooling_down","residue":{...}}.',
    );
    expect(manual).toContain("The JSON `script` value is a multi-line POSIX sh script.");
    expect(manual).toContain("If you choose silence/no action, return a script with only");
    expect(manual).toContain("Omit `--in` for this chat; never write `--in current`.");
    expect(manual).toContain("Do not parse CLI output with shell tools to get message IDs.");
    expect(manual).toContain("Reaction emoji must be Telegram-supported");
    expect(manual).toContain("## irc");
    expect(manual).toContain(
      "When you don't know who someone is or what's going on, a quick lookup (`irc whois`, `irc threads`) fills you in instantly.",
    );
    expect(manual).toContain("Batch pure reads in one script before you act.");
    expect(manual).toContain(
      "irc say [--in <chatId>] --text <message> [--resolve-thread <threadId>]",
    );
    expect(manual).toContain("irc join --target <target>");
    expect(manual).toContain(
      "irc forward --from <chatId> --ref <msgId> [--to <chatId>] [--comment <message>]",
    );
    expect(manual).not.toContain("irc whoami");
    expect(manual).toContain("## album");
    expect(manual).toContain(
      'When someone asks for a picture, search the group photo album before saying you cannot send one: `album search --query "visual words" --count 5`, then `album send --asset <assetId>` if a result fits.',
    );
    expect(manual).toContain(
      "`<command> --help` opens detailed usage for specialized tools. But most of the time you don't need any of this — just talk.",
    );
    expect(manual).not.toContain("man <topic>");
    expect(manual).toContain("## alice-pkg");
    expect(manual).toContain("alice-pkg install --name <skill>");
    expect(manual).toContain("alice-pkg list");
    expect(manual).not.toContain("## Command Catalog");
    expect(manual).not.toContain("## Core Commands");
  });

  it("omits context-derived social case internals from the visible self manual", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockResolvedValue("irc\nself\nalice-pkg\n");

    const manual = await generateShellManual([socialCaseMod]);

    expect(manual).toContain("self social-case-note");
    expect(manual).toContain("[--case <case>]");
    expect(manual).toContain("[--about <about>]");
    expect(manual).not.toContain("--caseId");
    expect(manual).not.toContain("case file id");
  });
});

describe("container probe mode", () => {
  it("uses the docker runner handshake for catalog probe", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockResolvedValue("irc\n");

    const root = mkdtempSync(join(tmpdir(), "alice-container-probe-"));
    const systemBinDir = join(root, "opt", "alice", "bin");
    mkdirSync(systemBinDir, { recursive: true });
    writeFileSync(join(systemBinDir, "irc"), "#!/usr/bin/env sh\n");
    chmodSync(join(systemBinDir, "irc"), 0o755);

    const catalog = await probeCommandCatalog({
      registry: {
        "alice-system": {
          name: "alice-system",
          version: "1.0.0",
          hash: "builtin-system",
          storePath: systemBinDir,
          commandPath: join(systemBinDir, "irc"),
          installedAt: "2026-03-11T00:00:00.000Z",
          actions: ["irc"],
          categories: ["app"],
          capabilities: [],
          backend: "shell",
        },
      },
      systemBinDir,
      env: { PATH: systemBinDir },
    });

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "alice-system",
        network: false,
        isolation: "sandboxed",
        extraMounts: expect.arrayContaining([
          expect.objectContaining({ source: systemBinDir, target: ALICE_CONTAINER_PATHS.bin }),
        ]),
      }),
    );
    expect(catalog.commands).toEqual([expect.objectContaining({ name: "irc" })]);
  });

  it("falls back to the host catalog when the container probe fails", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;
    mockDocker.mockRejectedValue(new Error("probe failed"));

    const root = mkdtempSync(join(tmpdir(), "alice-probe-fallback-"));
    const systemBinDir = join(root, "system-bin");
    const storePath = join(root, "store-weather");

    mkdirSync(systemBinDir, { recursive: true });
    mkdirSync(storePath, { recursive: true });

    writeFileSync(join(systemBinDir, "irc"), "#!/usr/bin/env sh\n");
    chmodSync(join(systemBinDir, "irc"), 0o755);

    writeFileSync(join(storePath, "weather"), "#!/usr/bin/env sh\n");
    chmodSync(join(storePath, "weather"), 0o755);
    symlinkSync(join(storePath, "weather"), join(systemBinDir, "weather"));
    writeFileSync(
      join(storePath, "manifest.yaml"),
      ["name: weather", 'version: "1.1.0"', 'description: "fallback weather"'].join("\n"),
    );

    const catalog = await probeCommandCatalog({
      registry: {
        "alice-system": {
          name: "alice-system",
          version: "1.0.0",
          hash: "builtin-system",
          storePath: systemBinDir,
          commandPath: join(systemBinDir, "irc"),
          installedAt: "2026-03-11T00:00:00.000Z",
          actions: ["irc"],
          categories: ["app"],
          capabilities: [],
          backend: "shell",
        },
        weather: {
          name: "weather",
          version: "1.1.0",
          hash: "hash-weather",
          storePath,
          commandPath: join(storePath, "weather"),
          installedAt: "2026-03-11T00:00:00.000Z",
          actions: ["use_weather_app"],
          categories: ["weather"],
          capabilities: [],
          backend: "shell",
        },
      },
      systemBinDir,
    });

    expect(catalog.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "irc" }),
        expect.objectContaining({ name: "weather", kind: "skill" }),
      ]),
    );
  });
});
