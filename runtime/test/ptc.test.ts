import { describe, expect, it } from "vitest";
import { executeProgram, executeToolReply, type PtcOptions, QUERY_KINDS } from "../src/llm/ptc.js";
import type { ActKind } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { TimelineEntry } from "../src/mind/state.js";

const NOW = Date.UTC(2026, 10, 14, 3, 0);

const timeline: TimelineEntry[] = [
  {
    at: NOW - 60_000,
    messageId: "41",
    sender: { id: "u1", name: "阿岚" },
    text: "发张猫看看",
    contentType: "text",
    replyToMessageId: null,
  },
  {
    at: NOW - 30_000,
    messageId: "43",
    sender: { id: "u1", name: "阿岚" },
    text: "在吗",
    contentType: "text",
    replyToMessageId: null,
  },
];

/** 这个会话里此刻能做的事（登记表里的 kind，不是 SDK 名）。 */
const KINDS: ActKind[] = [
  "send",
  "sticker",
  "react",
  "album-search",
  "album-send",
  "delegate",
  "chat-search",
];

function request(over: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    scope: "chat-1",
    chatType: "group",
    timeline,
    contributions: [],
    triggerMessageId: "43",
    at: NOW,
    affordances: KINDS,
    ...over,
  };
}

describe("executeProgram", () => {
  it("runs const, if, for and feeds a query result into the next call", async () => {
    const code = `
const found = await tools.search_album({ query: "猫" });
let asset = null;
for (const item of found.items) {
  if (item.tag === "cat") {
    asset = item.id;
    break;
  }
}
if (asset !== null) {
  await tools.send_photo({ asset });
  await tools.say({ text: "这张", replyTo: "43" });
}
`;
    const seen: Array<{ kind: string; args: Record<string, unknown>; aborted: boolean }> = [];
    const result = await executeProgram(code, request(), {
      onQuery: async (kind, args, signal) => {
        seen.push({ kind, args, aborted: signal.aborted });
        return {
          items: [
            { id: "a1", tag: "dog" },
            { id: "a2", tag: "cat" },
          ],
        };
      },
    });
    expect(result.defects).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("album-search");
    expect(seen[0]?.args.query).toBe("猫");
    expect(seen[0]?.aborted).toBe(false);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.act).toEqual({ kind: "album-search", query: "猫" });
    expect(result.queries[0]?.result).toEqual({
      items: [
        { id: "a1", tag: "dog" },
        { id: "a2", tag: "cat" },
      ],
    });
    expect(result.acts).toEqual([
      { kind: "album-send", asset: "a2" },
      { kind: "send", text: "这张", replyTo: "43" },
    ]);
  });

  it("unlocks send_photo inline after search_album succeeds, while rejecting send_photo without prior search", async () => {
    const onlySearch = request({ affordances: ["send", "album-search"] });
    const unsearched = await executeProgram(
      'await tools.send_photo({ asset: "p123" });',
      onlySearch,
    );
    expect(unsearched.acts).toEqual([]);
    expect(unsearched.defects.map((d) => d.kind)).toEqual(["code"]);

    const chained = await executeProgram(
      'const hits = await tools.search_album({ query: "猫" });\nif (hits.length > 0) await tools.send_photo({ asset: hits[0].asset });',
      onlySearch,
      { onQuery: async () => [{ asset: "pabc12", description: "橘猫" }] },
    );
    expect(chained.defects).toEqual([]);
    expect(chained.acts).toEqual([{ kind: "album-send", asset: "pabc12" }]);
  });

  it("recovers inside try/catch when a query throws and keeps going", async () => {
    const code = `
let found = null;
try {
  found = await tools.search_album({ query: "猫" });
} catch (err) {
  found = await tools.find_chats({ query: "猫群" });
  await tools.say({ text: "相册里没有" });
}
if (found) {
  await tools.say({ text: "找到 " + found.chats.length + " 个群" });
}
`;
    const result = await executeProgram(code, request(), {
      onQuery: async (kind) => {
        if (kind === "album-search") throw new Error("album down");
        return { chats: ["g1", "g2"] };
      },
    });
    expect(result.defects).toEqual([]);
    expect(result.queries.map((q) => q.act.kind)).toEqual(["album-search", "chat-search"]);
    expect(result.queries[0]?.error).toBe("Error: album down");
    expect(result.queries[1]?.result).toEqual({ chats: ["g1", "g2"] });
    expect(result.acts).toEqual([
      { kind: "send", text: "相册里没有", replyTo: null },
      { kind: "send", text: "找到 2 个群", replyTo: null },
    ]);
  });

  it("does not run anything when the program has a syntax error", async () => {
    const code = "await tools.say({ text: });";
    let called = false;
    const result = await executeProgram(code, request(), {
      onQuery: async () => {
        called = true;
      },
    });
    expect(result).toEqual({
      acts: [],
      defects: [{ kind: "unparseable", text: code }],
      queries: [],
    });
    expect(called).toBe(false);
  });

  it("reports an unknown tool and keeps the acts already made", async () => {
    const code = `
await tools.say({ text: "先说一句" });
await tools.delete_everything({});
await tools.say({ text: "到不了" });
`;
    const result = await executeProgram(code, request());
    expect(result.acts).toEqual([{ kind: "send", text: "先说一句", replyTo: null }]);
    expect(result.queries).toEqual([]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.kind).toBe("code");
    expect(result.defects[0]?.text).toContain("unknown tool: delete_everything");
  });

  it("reports invalid args and stops at the bad call", async () => {
    const code = `
await tools.say({ text: "先说一句" });
await tools.react({ messageId: "999", emoji: "👍" });
await tools.say({ text: "到不了" });
`;
    const result = await executeProgram(code, request());
    expect(result.acts).toEqual([{ kind: "send", text: "先说一句", replyTo: null }]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.text).toContain("invalid args for react");
  });

  it("enforces maxQueries", async () => {
    const code = `
for (let i = 0; i < 3; i++) {
  await tools.search_album({ query: "猫" });
}
`;
    const result = await executeProgram(code, request(), {
      maxQueries: 2,
      onQuery: async () => ({ items: [] }),
    });
    expect(result.queries).toHaveLength(2);
    expect(result.acts).toEqual([]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.text).toContain("too many queries (max 2)");
  });

  it("enforces maxCalls", async () => {
    const code = `
await tools.say({ text: "一" });
await tools.say({ text: "二" });
`;
    const result = await executeProgram(code, request(), { maxCalls: 1 });
    expect(result.acts).toHaveLength(1);
    expect(result.defects[0]?.text).toContain("too many tool calls (max 1)");
  });

  it("stops a program that never yields", async () => {
    const result = await executeProgram("while (true) {}", request(), { timeoutMs: 100 });
    expect(result.acts).toEqual([]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.kind).toBe("code");
    expect(result.defects[0]?.text).toContain("timed out");
  });

  it("stops an awaiting program at the deadline", async () => {
    const result = await executeProgram("await new Promise(() => {});", request(), {
      timeoutMs: 40,
    });
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.text).toBe("Error: timed out after 40ms");
  });

  it("honours an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const options: PtcOptions = { signal: controller.signal };
    const result = await executeProgram('await tools.say({ text: "不该发" });', request(), options);
    expect(result.acts).toEqual([]);
    expect(result.defects).toEqual([{ kind: "code", text: "aborted" }]);
  });

  it("keeps completed acts when the program throws", async () => {
    const result = await executeProgram(
      'await tools.say({ text: "一" });\nthrow new Error("boom");',
      request(),
    );
    expect(result.acts).toEqual([{ kind: "send", text: "一", replyTo: null }]);
    expect(result.defects[0]?.text).toContain("boom");
  });

  it("accepts mark_read even when the prompt did not list it", async () => {
    const result = await executeProgram(
      "await tools.mark_read();",
      request({ affordances: ["send"] }),
    );
    expect(result.acts).toEqual([{ kind: "mark-read" }]);
    expect(result.defects).toEqual([]);
  });

  it("leaves process and require out of the sandbox", async () => {
    const withProcess = await executeProgram("process.exit(0);", request());
    expect(withProcess.defects[0]?.text).toContain("process");

    const withRequire = await executeProgram('require("node:fs");', request());
    expect(withRequire.defects[0]?.text).toContain("require");
  });

  it("treats the five lookups as queries", () => {
    expect([...QUERY_KINDS].sort()).toEqual([
      "album-search",
      "chat-search",
      "delegate",
      "dm-check",
      "recall",
    ]);
  });
});

describe("executeToolReply", () => {
  it("executes run_code and records stray content", async () => {
    const code = `
const found = await tools.search_album({ query: "猫" });
if (found.items.length > 0) {
  await tools.say({ text: "有" });
}
`;
    const raw = JSON.stringify({
      content: "  这段字不会发出去  ",
      calls: [{ name: "run_code", arguments: JSON.stringify({ code }) }],
    });
    const result = await executeToolReply(raw, request(), {
      onQuery: async () => ({ items: [{ id: "a1" }] }),
    });
    expect(result.defects).toEqual([{ kind: "stray", text: "这段字不会发出去" }]);
    expect(result.decision.acts).toEqual([{ kind: "send", text: "有", replyTo: null }]);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.act).toEqual({ kind: "album-search", query: "猫" });
  });

  it("returns unparseable for text that is not JSON", async () => {
    const result = await executeToolReply("{not json", request());
    expect(result.decision.acts).toEqual([]);
    expect(result.defects).toEqual([{ kind: "unparseable", text: "{not json" }]);
    expect(result.queries).toEqual([]);
  });

  it("runs every run_code in order and reports other calls", async () => {
    const raw = JSON.stringify({
      content: "",
      calls: [
        {
          name: "run_code",
          arguments: JSON.stringify({ code: 'await tools.say({ text: "一" });' }),
        },
        { name: "search_album", arguments: JSON.stringify({ query: "猫" }) },
        { name: "run_code", arguments: "" },
        {
          name: "run_code",
          arguments: JSON.stringify({ code: 'await tools.say({ text: "二" });' }),
        },
      ],
    });
    const result = await executeToolReply(raw, request());
    expect(result.decision.acts).toEqual([
      { kind: "send", text: "一", replyTo: null },
      { kind: "send", text: "二", replyTo: null },
    ]);
    expect(result.defects).toEqual([
      { kind: "unknown", text: 'search_album({"query":"猫"})' },
      { kind: "unparseable", text: "" },
    ]);
  });
});
