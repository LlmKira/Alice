import { describe, expect, it } from "vitest";
import type { Act, ActKind } from "../src/mind/affordances.js";
import type { SpeechRequest } from "../src/mind/effects.js";
import { codeMode, walkProgram } from "../src/speech/decision.js";
import { renderSpeechPrompt } from "../src/speech/prompt.js";
import { modelReply, program } from "./model-reply.js";

const T0 = 1_771_000_000_000;

const OFFERED: ActKind[] = [
  "send",
  "sticker",
  "react",
  "mark-read",
  "leave-chat",
  "delegate",
  "intend",
  "feel",
  "think",
  "bed",
];

const request: SpeechRequest = {
  scope: "telegram:-5",
  chatType: "group",
  triggerMessageId: "3",
  at: T0 + 60_000,
  affordances: OFFERED,
  contributions: [
    {
      mechanism: "test",
      kind: "reference",
      text: "你平时在群里的几种回法：",
      examples: [
        { scene: "大家在刷屏", acts: [] },
        { scene: "有人发了个好笑的图", acts: [{ kind: "sticker", word: "laugh" }] },
      ],
    },
  ],
  timeline: [
    {
      at: T0,
      messageId: "2",
      sender: { id: "v", name: "小雨" },
      text: "显卡快 100 度了",
      contentType: "text",
      replyToMessageId: null,
    },
    {
      at: T0 + 1000,
      messageId: "3",
      sender: { id: "v", name: "小雨" },
      text: "要炸了",
      contentType: "text",
      replyToMessageId: null,
    },
  ],
};

describe("Code Mode: the SDK, the examples and run_code", () => {
  const prompt = renderSpeechPrompt("p", request);

  it("declares every offered act except mark_read, outward first, her inner ones marked as hers", () => {
    const names = [...prompt.system.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
    expect(names).toEqual([
      "say",
      "sticker",
      "react",
      "leave_chat",
      "look_up",
      "intend",
      "feel",
      "inner",
      "go_to_bed",
    ]);
    expect(prompt.system).toMatch(/\/\*\* （只有你自己看得到，不会发出去）记下你此刻的心情/);
    // 心情是她自己的词（PLAN 第 34 件）：不再是 14 个词的联合类型。
    expect(prompt.system).toContain("心情用你自己的词");
    expect(prompt.system).toContain("    mood: string;");
    expect(prompt.system).toContain(
      'type ToolReturn<K extends keyof ToolArgsMap> = K extends "look_up" ? string : void;',
    );
    expect(prompt.system).toContain(
      "declare const tools: {\n  [K in keyof ToolArgsMap]: (args: ToolArgsMap[K]) => Promise<ToolReturn<K>>;\n};",
    );
  });

  it("writes the examples as the program she hands back, and silence as not calling run_code", () => {
    expect(prompt.system).toContain("  ▸ 大家在刷屏\n    （不调用 run_code）");
    expect(prompt.system).toContain(
      '  ▸ 有人发了个好笑的图\n    await tools.sticker({ word: "laugh" });',
    );
  });

  it("offers one native tool, run_code, whose only argument is the program body", () => {
    expect(prompt.tools).toHaveLength(1);
    expect(prompt.tools?.[0]?.function.name).toBe("run_code");
    expect(prompt.tools?.[0]?.function.parameters).toMatchObject({ required: ["code"] });
  });
});

describe("Code Mode: the static read (never executed)", () => {
  const walk = (code: string) => walkProgram(code, request);

  it("reads back every act it can write", () => {
    const all: Act[] = [
      { kind: "think", thought: "要炸了还玩" },
      { kind: "react", messageId: "2", emoji: "😱" },
      { kind: "send", text: "快关机吧", replyTo: "3" },
      { kind: "send", text: '他说"要炸了"', replyTo: null },
      { kind: "sticker", word: "facepalm" },
      { kind: "delegate", task: "显卡多少度算危险" },
      { kind: "intend", when: "明天", what: "问他显卡修好没" },
      { kind: "feel", mood: "无聊", why: null },
      { kind: "mark-read" },
      { kind: "leave-chat" },
      { kind: "bed" },
    ];
    expect(codeMode.parse(modelReply(all), request)).toEqual({
      decision: { acts: all },
      defects: [],
    });
    expect(codeMode.parse(modelReply([]), request)).toEqual({
      decision: { acts: [] },
      defects: [],
    });
  });

  it("takes straight-line awaited tool calls with literal arguments, skipping comments", () => {
    const r = walk(
      '// 先想一下\nawait tools.inner({ thought: "嗯" });\nawait tools["say"]({ text: `好`, replyTo: 3 });\nawait tools.go_to_bed();\nreturn;\nawait tools.say({ text: "不会到这里" });',
    );
    expect(r.defects).toEqual([]);
    expect(r.acts).toEqual([
      { kind: "think", thought: "嗯" },
      { kind: "send", text: "好", replyTo: "3" },
      { kind: "bed" },
    ]);
  });

  it("counts everything else as a defect and does not run it", () => {
    const r = walk(
      [
        'const t = "好";',
        "await tools.say({ text: t });",
        'tools.say({ text: "没 await" });',
        'if (true) await tools.say({ text: "分支" });',
        'console.log("说一句");',
        "await tools.read_history({ n: 5 });",
        'await tools.feel({ mood: "" });',
        'await tools.say({ text: "这句算" });',
      ].join("\n"),
    );
    const natural = walk(
      'await tools.sticker({ word: "猫猫蓝屏崩溃" });\nawait tools.sticker({ word: "Happy" });',
    );
    expect(natural.defects).toEqual([]);
    expect(natural.acts).toEqual([
      { kind: "sticker", word: "猫猫蓝屏崩溃" },
      { kind: "sticker", word: "happy" },
    ]);
    // 心情是她自己的词（第 34 件）：空的心情才是参数缺陷（以前词表外的"超开心"是）。
    expect(r.acts).toEqual([{ kind: "send", text: "这句算", replyTo: null }]);
    expect(r.defects.map((d) => d.kind)).toEqual([
      "code",
      "args",
      "code",
      "code",
      "code",
      "unknown",
      "args",
    ]);
  });

  it("does nothing for a program that does not parse, or that is wrapped in a code fence", () => {
    const r = walk('await tools.say({ text: "好" });\nawait tools.say({ text: "没写完" ');
    expect(r.acts).toEqual([]);
    expect(r.defects.map((d) => d.kind)).toEqual(["unparseable"]);
    // ``` 在 TypeScript 里是带标签的模板字符串：语法上成立，整段是一个表达式，一件事也做不成。
    const fenced = walk('```ts\nawait tools.say({ text: "好" });\n```');
    expect(fenced.acts).toEqual([]);
    expect(fenced.defects.map((d) => d.kind)).toEqual(["code"]);
  });

  it("treats text outside run_code, other tool names and a reply that is not JSON as defects", () => {
    const raw = JSON.stringify({
      content: "好的",
      calls: [
        { name: "say", arguments: '{"text":"直接调"}' },
        { name: "run_code", arguments: '{"code":"await tools.say({ text: \\"好\\" });"}' },
        { name: "run_code", arguments: "{oops" },
      ],
    });
    const r = codeMode.parse(raw, request);
    expect(r.decision.acts).toEqual([{ kind: "send", text: "好", replyTo: null }]);
    expect(r.defects.map((d) => d.kind)).toEqual(["stray", "unknown", "unparseable"]);
    expect(codeMode.parse("（不说话）", request)).toEqual({
      decision: { acts: [] },
      defects: [{ kind: "unparseable", text: "（不说话）" }],
    });
  });

  it("takes only acts offered in this chat (a private chat cannot leave)", () => {
    const dm: SpeechRequest = { ...request, chatType: "private", affordances: ["send"] };
    const r = codeMode.parse(
      program('await tools.leave_chat();\nawait tools.say({ text: "嗯" });'),
      dm,
    );
    expect(r.decision.acts).toEqual([{ kind: "send", text: "嗯", replyTo: null }]);
    expect(r.defects.map((d) => d.kind)).toEqual(["unknown"]);
  });
});
