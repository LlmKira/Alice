import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Domain, loadDomains, Toolbox, web } from "../src/llm/domains.js";
import { TOOL_SPECS } from "../src/llm/errand-tools.js";

const deps = { exaKey: "", fetch, now: 0, timeoutMs: 5_000 };
const names = (box: Toolbox, final = false) => box.tools(final).map((t) => t.function.name);

const notes: Domain = {
  name: "notes",
  about: "翻她的笔记本",
  tools: [
    { type: "function", function: { name: "read_note", description: "读一页", parameters: {} } },
  ],
  run: async () => ({ text: "第三页：周五去看展", urls: [], usd: 0 }),
};

describe("executor domains", () => {
  it("with web alone, gives the executor exactly the tools it had before", () => {
    const box = new Toolbox([web]);
    expect(box.tools(false)).toEqual(TOOL_SPECS);
    expect(box.note).toBe("");
    expect(names(box, true)).toEqual(["hand_back"]);
  });

  it("with several domains, shows only use until the executor opens the one it needs", async () => {
    const box = new Toolbox([web, notes]);
    expect(names(box)).toEqual(["use", "hand_back"]);
    expect((await box.run("read_note", {}, deps)).text).toBe("No such tool.");
    await box.run("use", { domain: "notes" }, deps);
    expect(names(box)).toEqual(["read_note", "use", "hand_back"]);
    expect((await box.run("read_note", {}, deps)).text).toBe("第三页：周五去看展");
  });

  it("runs only the listed shell commands, without a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "domains-"));
    const config = join(dir, "domains.json");
    writeFileSync(
      config,
      JSON.stringify([{ name: "files", about: "看文件", shell: { cwd: dir, commands: ["echo"] } }]),
    );
    const [, files] = await loadDomains(config);
    if (!files) throw new Error("no shell domain");
    expect(
      (await files.run("run_command", { command: "echo", args: ["$HOME", "hi"] }, deps)).text,
    ).toBe("$HOME hi\n");
    expect(
      (await files.run("run_command", { command: "rm", args: ["-rf", dir] }, deps)).text,
    ).toMatch(/^Failed/);
  });

  it("supports a personal desk workspace for notes and rejects path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-"));
    const config = join(dir, "domains.json");
    const deskDir = join(dir, "workspace");
    writeFileSync(
      config,
      JSON.stringify([
        { name: "desk", about: "personal notes and bookmarks", desk: { dir: deskDir } },
      ]),
    );
    const [, desk] = await loadDomains(config);
    if (!desk) throw new Error("no desk domain");

    expect((await desk.run("list_notes", {}, deps)).text).toBe("(empty desk)");
    expect(
      (await desk.run("write_note", { path: "music/favs.md", content: "- MGS2 Main Theme" }, deps))
        .text,
    ).toMatch(/^Saved music\/favs\.md/);
    expect(
      (await desk.run("append_note", { path: "music/favs.md", content: "- Golden Kamuy OP" }, deps))
        .text,
    ).toBe("Appended to music/favs.md.");
    expect((await desk.run("read_note", { path: "music/favs.md" }, deps)).text).toBe(
      "- MGS2 Main Theme\n- Golden Kamuy OP",
    );
    expect((await desk.run("list_notes", {}, deps)).text).toBe("music/favs.md (35B)");
    expect((await desk.run("read_note", { path: "../domains.json" }, deps)).text).toMatch(
      /escapes desk workspace/,
    );
    expect(
      (await desk.run("write_note", { path: "/tmp/escape.md", content: "no" }, deps)).text,
    ).toMatch(/escapes desk workspace/);
  });
});
