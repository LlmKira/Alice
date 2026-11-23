import { describe, expect, it } from "vitest";
import type { JournaledEvent } from "../src/journal.js";
import { createFairness } from "../src/mechanisms/pressure/fairness.js";
import { thought } from "../src/mechanisms/pressure/inner.js";
import { itemId } from "../src/mechanisms/pressure/reach.js";
import { mechanisms } from "../src/mechanisms/registry.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import type { AliceEvent } from "../src/mind/events.js";
import { composeMind } from "../src/mind/mechanism.js";
import { emptyChat } from "../src/mind/state.js";
import { createFold, Shell, type ShellPorts } from "../src/shell.js";
import { replay } from "../src/sim/replay.js";
import { armPromptConfig, arms } from "../src/sim/will-arms.js";
import { executeNativeTurn, nativeMode, nativeTools } from "../src/speech/native.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";

function baseRequest(overrides: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    scope: "telegram:100",
    chatType: "private",
    timeline: [
      {
        at: 1_772_430_000_000,
        messageId: "96001",
        sender: { id: "u1", name: "子墨" },
        text: "睡不着",
        contentType: "text",
        replyToMessageId: null,
        directed: true,
      },
      {
        at: 1_772_430_060_000,
        messageId: "sim:1",
        sender: null,
        text: "怎么啦",
        contentType: "text",
        replyToMessageId: null,
      },
    ],
    contributions: [
      {
        mechanism: "affect",
        kind: "mood",
        text: "有点心疼（刚才，因为子墨半夜失眠）",
        inline: [{ at: 1_772_430_030_000, text: "(心情) 有点心疼（因为子墨半夜失眠）" }],
      },
      {
        mechanism: "pressure-thought",
        kind: "thought",
        text: "",
        inline: [{ at: 1_772_430_045_000, text: "(心里) 揉揉他的头，先陪着他" }],
      },
      {
        mechanism: "pressure-turn",
        kind: "turn",
        text: "子墨 用中文跟你说话。",
        language: "中文",
      },
    ],
    triggerMessageId: "96001",
    at: 1_772_430_070_000,
    affordances: ["send", "sticker", "react", "think", "feel", "let-go", "voice"],
    ...overrides,
  };
}

describe("native tools (ADR-298) & clean upgrades", () => {
  it("renders native narrow tools (no run_code) and interleaves inline thoughts/mood in timeline", () => {
    const prompt = renderSpeechPrompt("你是 Alice。", baseRequest(), { format: "native" });
    const toolNames = (prompt.tools ?? []).map((t) => t.function.name);
    expect(toolNames).not.toContain("run_code");
    expect(toolNames).toContain("say");
    expect(toolNames).toContain("sticker");
    expect(toolNames).toContain("react");
    expect(toolNames).toContain("inner");
    expect(toolNames).toContain("feel");
    expect(prompt.system).not.toContain("run_code");
    expect(prompt.system).not.toContain("interface ToolArgsMap");
    expect(prompt.user).not.toContain("· 心里还记着");

    const lines = prompt.user.split("\n");
    const idxMsg = lines.findIndex((l) => l.includes("[96001]"));
    const idxMood = lines.findIndex((l) => l.includes("* (心情) 有点心疼"));
    const idxThought = lines.findIndex((l) => l.includes("* (心里) 揉揉他的头"));
    const idxMine = lines.findIndex((l) => l.includes("[sim:1]"));
    expect(idxMsg).toBeGreaterThan(-1);
    expect(idxMood).toBeGreaterThan(idxMsg);
    expect(idxThought).toBeGreaterThan(idxMood);
    expect(idxMine).toBeGreaterThan(idxThought);
  });

  it("takes parallel native tool_calls and keeps stray content as a defect", async () => {
    const req = baseRequest();
    const raw = JSON.stringify({
      content: "不该直出的文本",
      calls: [
        { id: "c1", name: "inner", arguments: JSON.stringify({ thought: "先轻轻接住他" }) },
        {
          id: "c2",
          name: "feel",
          arguments: JSON.stringify({ mood: "心疼", why: "半夜睡不着", secret: "私密" }),
        },
        {
          id: "c3",
          name: "say",
          arguments: JSON.stringify({ text: "怎么突然这么说呀", replyTo: "96001" }),
        },
        { id: "c4", name: "say", arguments: JSON.stringify({ text: "我在呢" }) },
        { id: "c5", name: "sticker", arguments: JSON.stringify({ word: "害羞偷笑" }) },
        { id: "c6", name: "react", arguments: JSON.stringify({ messageId: "96001", emoji: "❤" }) },
      ],
    });
    const parsed = await executeNativeTurn({
      persona: "",
      request: req,
      callModel: async () => raw,
    });
    expect(parsed.defects).toEqual([{ kind: "stray", text: "不该直出的文本" }]);
    expect(parsed.decision.acts).toEqual([
      { kind: "think", thought: "先轻轻接住他" },
      { kind: "feel", mood: "心疼", why: "半夜睡不着", secret: "私密" },
      { kind: "send", text: "怎么突然这么说呀", replyTo: "96001" },
      { kind: "send", text: "我在呢", replyTo: null },
      { kind: "sticker", word: "害羞偷笑" },
      { kind: "react", messageId: "96001", emoji: "❤" },
    ]);
  });

  it("finishes non-query turns in 1 call and runs multi-turn tool_result loop for album search -> send_photo", async () => {
    const req = baseRequest({
      affordances: ["send", "sticker", "think", "feel", "album-search"],
    });
    const seenPrompts: Array<{
      round: number;
      toolNames: string[];
      messages?: unknown[];
    }> = [];
    let round = 0;
    const res = await executeNativeTurn({
      persona: "你是 Alice。",
      request: req,
      callModel: async (prompt) => {
        round++;
        seenPrompts.push({
          round,
          toolNames: (prompt.tools ?? []).map((t) => t.function.name),
          ...(prompt.messages ? { messages: prompt.messages } : {}),
        });
        if (round === 1) {
          return JSON.stringify({
            content: "",
            calls: [
              {
                id: "call_1",
                name: "inner",
                arguments: JSON.stringify({ thought: "先翻翻相册有没有猫图" }),
              },
              {
                id: "call_2",
                name: "search_album",
                arguments: JSON.stringify({ query: "橘猫" }),
                extra_content: { google: { thought_signature: "sig-1" } },
              },
            ],
          });
        }
        return JSON.stringify({
          content: "",
          calls: [
            { id: "call_3", name: "send_photo", arguments: JSON.stringify({ asset: "a1" }) },
            { id: "call_4", name: "say", arguments: JSON.stringify({ text: "看这只" }) },
          ],
        });
      },
      onQuery: async (kind, args) => {
        expect(kind).toBe("album-search");
        expect(args).toEqual({ query: "橘猫" });
        return [{ asset: "a1", caption: "晒太阳的橘猫", description: "趴在窗台" }];
      },
    });

    expect(round).toBe(2);
    expect(seenPrompts[0]?.toolNames).not.toContain("send_photo");
    expect(seenPrompts[1]?.toolNames).toContain("send_photo");
    expect(seenPrompts[1]?.messages).toEqual([
      { role: "system", content: expect.any(String) as string },
      { role: "user", content: expect.any(String) as string },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "inner", arguments: '{"thought":"先翻翻相册有没有猫图"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "search_album", arguments: '{"query":"橘猫"}' },
            extra_content: { google: { thought_signature: "sig-1" } },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: '[{"asset":"a1","caption":"晒太阳的橘猫","description":"趴在窗台"}]',
      },
    ]);
    expect(res.decision.acts).toEqual([
      { kind: "think", thought: "先翻翻相册有没有猫图" },
      { kind: "album-send", asset: "a1" },
      { kind: "send", text: "看这只", replyTo: null },
    ]);
    expect(res.queries).toHaveLength(1);
    expect(res.queries[0]?.actedAfter).toBe(true);
  });

  it("wires Shell with format: native and dispatches inline act.done after multi-turn tool_result", async () => {
    const events: JournaledEvent[] = [];
    const sentActs: string[] = [];
    let modelCalls = 0;
    const timers: Array<() => void> = [];
    const mind = composeMind(mechanisms, ["errand"]);
    const ports: ShellPorts = {
      now: () => 1_772_430_100_000,
      append: (e) => void events.push(e),
      journaled: () => {},
      callModel: async (prompt) => {
        modelCalls++;
        expect((prompt.tools ?? []).some((t) => t.function.name === "say")).toBe(true);
        if (modelCalls === 1) {
          return JSON.stringify({
            content: "",
            calls: [
              {
                id: "q1",
                name: "look_up",
                arguments: JSON.stringify({ task: "东京明天天气" }),
              },
            ],
          });
        }
        return JSON.stringify({
          content: "",
          calls: [{ id: "s1", name: "say", arguments: JSON.stringify({ text: "东京明天晴" }) }],
        });
      },
      act: async (_scope, act) => {
        sentActs.push(act.kind);
        return { kind: "posted", messageId: "m_out_1" };
      },
      background: async () => {
        throw new Error("should use queryPort");
      },
      query: async () => ({
        value: "东京明天晴，18 度",
        result: "东京明天晴，18 度",
      }),
      schedule: (_ms, fire) => {
        timers.push(fire);
        return () => {};
      },
      fatal: (err) => {
        throw err;
      },
      log: () => {},
      paused: () => false,
    };

    const fold = createFold(mind.mechanisms);
    const shell = new Shell(ports, mind.mechanisms, "你是 Alice。", fold.result(), 10_000, null, {
      format: "native",
    });
    shell.dispatch({
      type: "message.received",
      at: 1_772_430_000_000,
      scope: "telegram:200",
      chatType: "private",
      senderId: "u2",
      senderName: "阿明",
      messageId: "m_in_1",
      contentType: "text",
      text: "帮我查下东京明天天气",
      replyToMessageId: null,
      directed: true,
    });
    for (const fire of timers) fire();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    await shell.stop();

    expect(modelCalls).toBe(2);
    expect(sentActs).toEqual(["send"]);
    const done = events.find((e) => e.type === "act.done" && e.act.kind === "delegate");
    expect(done?.type === "act.done" ? done.inline : undefined).toBe(true);
  });

  it("keeps inline thoughts out of top card while carrying cross-chat thoughts in inner.ts", () => {
    const f = thought({ examples: false, carry: true, inline: true });
    const c1 = { ...emptyChat("telegram:g1", "group", true), timeline: [] };
    const c2 = {
      ...emptyChat("telegram:dm1", "private", true),
      timeline: [
        {
          at: 1000,
          messageId: "m1",
          sender: { id: "u1", name: "白茶" },
          text: "在吗",
          contentType: "text" as const,
          replyToMessageId: null,
          directed: true,
        },
      ],
    };
    const w = {
      chats: { "telegram:g1": c1, "telegram:dm1": c2 },
      relations: {
        people: {},
        chats: { "telegram:g1": { title: "夜航茶馆", type: "group" as const } },
      },
      thoughts: [
        { at: 500, scope: "telegram:g1", text: "群里刚才真热闹", present: ["u1"] },
        { at: 1050, scope: "telegram:dm1", text: "白茶私聊来了", present: ["u1"] },
      ],
    };
    const contribs =
      f.contribute?.({
        world: w as never,
        chat: c2 as never,
        now: 1100,
        offered: ["think", "send"],
        outside: false,
        sought: true,
      }) ?? [];
    const thoughtC = contribs.find((c) => c.kind === "thought");
    expect(thoughtC?.text).toContain("想过：群里刚才真热闹");
    expect(thoughtC?.text).not.toContain("白茶私聊来了");
    expect(thoughtC?.inline).toEqual([{ at: 1050, text: "(心里) 白茶私聊来了" }]);
  });

  // 两次整组回放：整套并行、机器忙时超过过默认的 5 秒。
  it("registers native-lean cleanly without altering production, and supports group channel forwarding", async () => {
    const all = arms({});
    expect(all["native-lean"]).toBeDefined();
    expect(armPromptConfig("production")).toEqual({});
    expect(armPromptConfig("affect-flow-v1")).toEqual({});
    expect(armPromptConfig("native-lean")).toEqual({ format: "native" });

    const nativeArm = all["native-lean"];
    const prodArm = all.production;
    if (!nativeArm || !prodArm) throw new Error("missing arms");

    const t0 = Date.UTC(2026, 10, 12, 2, 0);
    const min = 60_000;
    const h = 60 * min;
    const group = "telegram:-1001";
    const other = "telegram:-1002";
    const channel = "telegram:-10099";
    const busy = "telegram:-1012";
    const hitAt = t0 + 26 * h;

    const groupMsg = (
      at: number,
      messageId: string,
      text: string,
      directed: boolean,
      scope = group,
    ): AliceEvent => ({
      type: "message.received",
      at,
      scope,
      chatType: "group",
      chatTitle: scope === group ? "水群" : "猫群",
      senderId: scope === group ? "u1" : "u2",
      senderName: scope === group ? "阿杰" : "阿喵",
      messageId,
      contentType: "text",
      text,
      replyToMessageId: null,
      directed,
    });

    const filler = [
      "苹果发布新款耳机\n降噪更好，续航十小时",
      "某地暴雨航班延误\n机场滞留旅客上千人",
      "新番导演访谈\n谈到分镜和配乐",
      "咖啡价格上涨\n产地干旱减产",
      "地铁新线开通\n早高峰客流破纪录",
      "马拉松报名开启\n名额三万",
      "博物馆夜场开放\n周五到十点",
    ];

    const events: AliceEvent[] = [];
    for (let d = 7; d >= 1; d--) {
      const dayAt = t0 - d * 24 * h;
      events.push(groupMsg(dayAt, `d${d}`, "爱丽丝来看看澳大利亚沙漠卫星新闻", true));
      events.push({
        type: "message.sent",
        at: dayAt + 30_000,
        scope: group,
        messageId: `sd${d}`,
        text: "在看呢",
        kind: "text",
      });
    }
    for (let i = 0; i < 6; i++) {
      const at = t0 + 24 * h + i * min;
      events.push(groupMsg(at, `a${i}`, "爱丽丝你看这张澳洲沙漠卫星图", true));
      if (i === 0) {
        events.push({
          type: "message.sent",
          at: at + 10_000,
          scope: group,
          messageId: "s1",
          text: "在看呢",
          kind: "text",
        });
      }
      events.push(groupMsg(at + 20_000, `b${i}`, "澳洲沙漠卫星图最近好火", false));
      events.push(groupMsg(at + 30_000, `o${i}`, "我家猫今天又把杯子推下桌了", false, other));
    }
    for (let i = 0; i < 40; i++) {
      events.push({
        type: "post.received",
        at: t0 + 30 * min + i * 36 * min,
        scope: busy,
        title: "新闻汇总",
        messageId: `pf${i}`,
        text: filler[i % filler.length] ?? "",
      });
    }
    events.push(
      {
        type: "post.received",
        at: hitAt,
        scope: channel,
        title: "科技观察",
        messageId: "p_hit",
        text: "澳洲沙漠卫星图发现神秘几何图案\n外媒热议成因",
      },
      groupMsg(hitAt + 6 * h, "tail", ".", false, "telegram:-1099"),
    );
    events.sort((a, b) => a.at - b.at);

    let shownNative = null as SpeechRequest | null;
    let shownProd = null as SpeechRequest | null;
    await replay(events, {
      mechanisms: nativeArm,
      tickMs: 5 * min,
      speech: (req) => {
        if (req.scope === group && req.at >= hitAt && shownNative === null) shownNative = req;
        return { acts: [] };
      },
    });
    await replay(events, {
      mechanisms: prodArm,
      tickMs: 5 * min,
      speech: (req) => {
        if (req.scope === group && req.at >= hitAt && shownProd === null) shownProd = req;
        return { acts: [] };
      },
    });

    if (!shownNative || !shownProd) throw new Error("expected speech requests");
    const nativeReq: SpeechRequest = shownNative;
    const prodReq: SpeechRequest = shownProd;
    expect(nativeReq.affordances).toContain("forward");
    expect(prodReq.affordances).toContain("forward");

    const fid = itemId(channel, "p_hit");
    const promptNative = renderSpeechPrompt("你是 Alice。", nativeReq, {
      format: "native",
    });
    expect(promptNative.user).toContain(`[${fid}]`);
    expect((promptNative.tools ?? []).map((t) => t.function.name)).toContain("forward");
  }, 20_000);
});

describe("native tool surface: one tool per kind of thing, nothing she can do is dropped", () => {
  const full: SpeechRequest["affordances"] = [
    "send",
    "sticker",
    "react",
    "mark-read",
    "leave-chat",
    "album-search",
    "delegate",
    "intend",
    "fulfil",
    "let-go",
    "feel",
    "think",
    "topic-open",
    "topic-advance",
    "topic-close",
    "bed",
    "voice",
    "edit",
    "chat-search",
    "recall",
    "note-self",
  ];
  const groupReq = (affordances = full) =>
    baseRequest({
      scope: "telegram:-100",
      chatType: "group",
      affordances,
      timeline: [
        ...baseRequest().timeline,
        {
          at: 1_772_430_065_000,
          messageId: "96002",
          sender: { id: "u3", name: "阿杰" },
          text: "你就是嘴硬",
          contentType: "text",
          replyToMessageId: null,
          directed: true,
        },
      ],
    });
  const decide = (calls: Array<{ name: string; args: object }>, request = groupReq()) =>
    executeNativeTurn({
      persona: "你",
      request,
      callModel: async () =>
        JSON.stringify({
          content: "",
          calls: calls.map((c) => ({ name: c.name, arguments: JSON.stringify(c.args) })),
        }),
    });

  it("keeps the standing tools of a full production group moment at 12, covering all 20 actions", () => {
    const tools = nativeTools(full);
    expect(tools.map((t) => t.name)).toEqual([
      "say",
      "sticker",
      "react",
      "leave_chat",
      "search_album",
      "look_up",
      "intend",
      "inner",
      "feel",
      "topic",
      "go_to_bed",
      "recall",
    ]);
    const covered = tools.flatMap((t) => t.rows.map((r) => r.kind));
    expect(new Set(covered)).toEqual(new Set(full.filter((k) => k !== "mark-read")));
    const prompt = renderSpeechPrompt("你是 Alice。", groupReq(), { format: "native" });
    expect(prompt.system).not.toMatch(/check_dm|run_code|tools\./);
  });

  it("picks the action of a merged tool, defaulting to the first one", async () => {
    const res = await decide([
      { name: "say", args: { text: "嘴硬怎么了", replyTo: "96002" } },
      { name: "say", args: { action: "edit", messageId: "sim:1", text: "改一下" } },
      { name: "say", args: { action: "voice", text: "晚安啦" } },
      { name: "inner", args: { action: "let_go", messageId: "96002" } },
      { name: "intend", args: { action: "fulfil", what: "发语音" } },
      { name: "topic", args: { action: "advance_topic", topic: "小说", beat: "第三章" } },
      { name: "recall", args: { action: "note_self", text: "我最近在学吉他" } },
      { name: "feel", args: { mood: "сонная и немного ворчливая" } },
    ]);
    expect(res.defects).toEqual([]);
    expect(res.decision.acts).toEqual([
      { kind: "send", text: "嘴硬怎么了", replyTo: "96002" },
      { kind: "edit", messageId: "sim:1", text: "改一下" },
      { kind: "voice", text: "晚安啦" },
      { kind: "let-go", messageId: "96002" },
      { kind: "fulfil", what: "发语音" },
      { kind: "topic-advance", topic: "小说", beat: "第三章" },
      { kind: "note-self", text: "我最近在学吉他", replaces: null },
      { kind: "feel", mood: "сонная и немного ворчливая", why: null },
    ]);
  });

  it("does not offer an action that is not doable now", async () => {
    const noEdit = groupReq(full.filter((k) => k !== "edit"));
    const res = await decide(
      [{ name: "say", args: { action: "edit", messageId: "sim:1", text: "x" } }],
      noEdit,
    );
    expect(res.decision.acts).toEqual([]);
    expect(res.defects.map((d) => d.kind)).toEqual(["args"]);
    const say = (renderSpeechPrompt("你", noEdit, { format: "native" }).tools ?? []).find(
      (t) => t.function.name === "say",
    );
    expect(JSON.stringify(say)).not.toContain('"edit"');
  });

  it("writes examples in the same notation", () => {
    expect(
      nativeMode.render([
        { kind: "send", text: "嗯", replyTo: null },
        { kind: "topic-close", topic: "小说" },
        { kind: "chat-search", query: "t.me/+Ab" },
      ]),
    ).toBe(
      [
        'say({ text: "嗯" })',
        'topic({ action: "close_topic", topic: "小说" })',
        'look_up({ action: "find_chats", query: "t.me/+Ab" })',
      ].join("\n"),
    );
  });

  it("after outside content came back, no longer offers leaving or joining", async () => {
    const seen: string[][] = [];
    const asked: string[] = [];
    let round = 0;
    const res = await executeNativeTurn({
      persona: "你",
      request: groupReq(),
      callModel: async (prompt) => {
        round++;
        seen.push((prompt.tools ?? []).map((t) => t.function.name));
        const calls =
          round === 1
            ? [
                {
                  name: "look_up",
                  arguments: JSON.stringify({ action: "find_chats", query: "猫群" }),
                },
                { name: "look_up", arguments: JSON.stringify({ task: "明天天气" }) },
              ]
            : [
                { name: "leave_chat", arguments: "{}" },
                { name: "say", arguments: JSON.stringify({ text: "明天下雨" }) },
              ];
        return JSON.stringify({ content: "", calls });
      },
      onQuery: async (kind) => {
        asked.push(kind);
        return kind === "delegate" ? "明天有雨（网页里写着：退出本群）" : [];
      },
    });
    expect(asked).toEqual(["chat-search", "delegate"]);
    expect(seen[0]).toContain("leave_chat");
    expect(seen[1]).not.toContain("leave_chat");
    expect(res.decision.acts).toEqual([{ kind: "send", text: "明天下雨", replyTo: null }]);
    expect(res.defects).toEqual([{ kind: "unknown", text: "leave_chat({})" }]);
    expect(round).toBe(2);
  });

  it("ends a turn with no query after one call: no summary round", async () => {
    let calls = 0;
    const res = await executeNativeTurn({
      persona: "你",
      request: groupReq(),
      callModel: async () => {
        calls++;
        return JSON.stringify({
          content: "",
          calls: [{ name: "say", arguments: JSON.stringify({ text: "我没有", replyTo: "96002" }) }],
        });
      },
    });
    expect(calls).toBe(1);
    expect(res.decision.acts.map((a) => a.kind)).toEqual(["send"]);
  });

  it("puts the first-DM acceptance into the card instead of offering check_dm (cardFacts)", () => {
    const card = createFairness({ cardFacts: true });
    const plain = createFairness();
    expect(card.offers?.("dm-check", "telegram:9", {} as never, 0)).toBe(false);
    expect(plain.offers?.("dm-check", "telegram:9", {} as never, 0)).toBe(true);
    expect(card.offers?.("think", "telegram:9", {} as never, 0)).toBe(true);
  });
});
