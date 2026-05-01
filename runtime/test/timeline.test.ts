/**
 * ADR-118: 统一时间线 单元测试。
 *
 * @see src/engine/act/timeline.ts
 * @see docs/adr/118-unified-timeline.md
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAudioMediaText,
  formatImageOcrMetaText,
  formatStickerMediaText,
  type MessageRecord,
} from "../src/engine/act/messages.js";

// Mock DB 查询（ThoughtTimelineSource 依赖）
vi.mock("../src/db/queries.js", () => ({
  getRecentActionsByChat: vi.fn(() => []),
}));

import { getRecentActionsByChat } from "../src/db/queries.js";
import {
  buildTimeline,
  MessageTimelineSource,
  ObservationTimelineSource,
  renderMessageContent,
  renderTimeline,
  ThoughtTimelineSource,
  type TimelineEntry,
} from "../src/engine/act/timeline.js";

// ── 测试工具 ──────────────────────────────────────────────────────────────

/** 创建测试用 MessageRecord。 */
function msg(
  id: number,
  isOutgoing: boolean,
  date: Date,
  overrides?: Partial<MessageRecord>,
): MessageRecord {
  return {
    id,
    senderName: isOutgoing ? "Alice" : `User${id}`,
    senderId: isOutgoing ? undefined : id,
    isOutgoing,
    text: `msg-${id}`,
    date,
    ...overrides,
  };
}

/** 从 Date 推导 IRC 风格时间字符串，与 timeline.ts 一致。 */
function _ircTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// ═══════════════════════════════════════════════════════════════════════════
// MessageTimelineSource
// ═══════════════════════════════════════════════════════════════════════════

describe("MessageTimelineSource", () => {
  it("基本 IRC 格式渲染（不含时间戳前缀）", () => {
    const d1 = new Date("2025-06-01T10:00:00Z");
    const d2 = new Date("2025-06-01T10:01:00Z");
    const messages: MessageRecord[] = [
      msg(1, false, d1, { senderName: "Bob", senderId: 42 }),
      msg(2, true, d2),
    ];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    expect(entries).toHaveLength(2);
    // 入站消息：有 senderId tag，无 [HH:MM] 前缀
    expect(entries[0].kind).toBe("message");
    expect(entries[0].rendered).toContain("Bob @42");
    expect(entries[0].rendered).toContain("(1)");
    expect(entries[0].rendered).toContain(": msg-1");
    expect(entries[0].rendered).not.toMatch(/^\[/); // 不以 [HH:MM] 开头
    // 出站消息：Alice (you)，无 senderId tag
    expect(entries[1].rendered).toContain("Alice (you)");
    expect(entries[1].rendered).not.toContain("@");
  });

  it("reply/edit/fwd/reaction 元数据标记", () => {
    const d = new Date("2025-06-01T12:00:00Z");
    const messages: MessageRecord[] = [
      msg(5, false, d, {
        replyToId: 3,
        isEdited: true,
        forwardFrom: "Channel @99",
        reactions: { "👍": 10, "❤️": 5, "😂": 3, "🔥": 1 },
      }),
    ];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    expect(entries[0].rendered).toContain("↩3");
    expect(entries[0].rendered).toContain("[edited]");
    expect(entries[0].rendered).toContain("[fwd Channel @99]");
    // top 3 reactions
    expect(entries[0].rendered).toContain("[👍×10 ❤️×5 😂×3]");
    expect(entries[0].rendered).not.toContain("🔥");
  });

  it("无 segments 的消息 text 截断到 200 字符", () => {
    const d = new Date("2025-06-01T12:00:00Z");
    const longText = "A".repeat(300);
    const source = new MessageTimelineSource([msg(1, false, d, { text: longText })]);
    const entries = source.entries("channel:1", 0, Date.now());

    expect(entries[0].rendered).toContain(`${"A".repeat(200)}...`);
    expect(entries[0].rendered).not.toContain("A".repeat(201));
  });

  it("上下文分隔符 — diffused + mention 切换", () => {
    const base = new Date("2025-06-01T10:00:00Z");
    const messages: MessageRecord[] = [
      msg(1, false, new Date(base.getTime() + 0), { isDiffused: true }),
      msg(2, false, new Date(base.getTime() + 1000), { isDiffused: true }),
      msg(3, false, new Date(base.getTime() + 2000)), // 切回 none
      msg(4, false, new Date(base.getTime() + 3000), { isMentionContext: true }),
      msg(5, false, new Date(base.getTime() + 4000)), // 切回 none
    ];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    const rendered = entries.map((e) => e.rendered);
    expect(rendered).toContain("--- context: reply chain ---");
    expect(rendered).toContain("--- context: unanswered mention ---");
    expect(rendered.filter((r) => r === "--- end context ---")).toHaveLength(2);
  });

  it("尾部 context 自动关闭", () => {
    const d = new Date("2025-06-01T10:00:00Z");
    const messages: MessageRecord[] = [msg(1, false, d, { isDiffused: true })];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    const last = entries[entries.length - 1];
    expect(last.kind).toBe("context");
    expect(last.rendered).toBe("--- end context ---");
  });

  it("不再在源内注入 gap（gap 由 buildTimeline 统一处理）", () => {
    const t0 = new Date("2025-06-01T10:00:00Z");
    const t1 = new Date(t0.getTime() + 45 * 60_000); // +45min
    const messages: MessageRecord[] = [msg(1, false, t0), msg(2, false, t1)];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    // 源不产出 gap 条目，只有消息
    expect(entries.filter((e) => e.kind === "gap")).toHaveLength(0);
    expect(entries.filter((e) => e.kind === "message")).toHaveLength(2);
  });

  it("入站消息被 Alice 回复过时，只投影事实，不做硬拦截", () => {
    const d = new Date("2025-06-01T10:00:00Z");
    const messages: MessageRecord[] = [
      msg(10, false, d, { text: "晚上好" }),
      msg(11, true, new Date(d.getTime() + 1000), {
        text: "晚上好~",
        replyToId: 10,
      }),
    ];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    const inbound = entries.find((e) => e.rendered.includes("User10"));
    expect(inbound?.rendered).toContain("already replied by you: #11");
    expect(inbound?.rendered).not.toContain("STOP");
  });

  it("群组模式 — presence hint 注入为 context 类型", () => {
    const d = new Date("2025-06-01T10:00:00Z");
    const messages: MessageRecord[] = [
      msg(1, false, new Date(d.getTime())),
      msg(2, true, new Date(d.getTime() + 1000)),
      msg(3, true, new Date(d.getTime() + 2000)),
      msg(4, true, new Date(d.getTime() + 3000)),
      msg(5, true, new Date(d.getTime() + 4000)),
    ];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    const hintEntry = entries.find((e) => e.rendered.includes("consecutive from you"));
    expect(hintEntry).toBeDefined();
    expect(hintEntry?.kind).toBe("context"); // context 类型，不是 message
    expect(hintEntry?.rendered).toContain("STOP, wait for their reply");
  });

  it("非群组模式 — 也注入 presence hint（ADR-159: 私聊连发重灾区）", () => {
    const d = new Date("2025-06-01T10:00:00Z");
    const messages: MessageRecord[] = [
      msg(1, true, new Date(d.getTime())),
      msg(2, true, new Date(d.getTime() + 1000)),
      msg(3, true, new Date(d.getTime() + 2000)),
    ];
    const source = new MessageTimelineSource(messages);
    const entries = source.entries("channel:1", 0, Date.now());

    const hintEntry = entries.find((e) => e.rendered.includes("consecutive"));
    expect(hintEntry).toBeDefined();
    expect(hintEntry?.rendered).toContain("3 consecutive from you");
  });

  it("空消息列表 → 空 entries", () => {
    const source = new MessageTimelineSource([]);
    expect(source.entries("channel:1", 0, Date.now())).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderMessageContent — 优先级感知截断
// ═══════════════════════════════════════════════════════════════════════════

describe("renderMessageContent", () => {
  it("audio 媒体投影为音乐而不是 voice", () => {
    const result = formatAudioMediaText({
      title: "Blue",
      performer: "Yoko Kanno",
      duration: 215,
      fileName: "blue.mp3",
    });

    expect(result).toBe("(audio 🎵: Blue — Yoko Kanno, 3:35)");
    expect(result).not.toContain("voice");
  });

  it("audio 缺少曲目信息时回退到文件名", () => {
    const result = formatAudioMediaText({
      title: null,
      performer: null,
      duration: 0,
      fileName: "unknown-track.mp3",
    });

    expect(result).toBe("(audio 🎵: unknown-track.mp3)");
  });

  it("sticker 有 description 时隐藏 alt emoji", () => {
    const result = formatStickerMediaText({
      emoji: "☹️",
      title: "可莉姆船长",
      description: "a small captain looking worried",
      fileId: "CAAC",
    });

    expect(result).toBe("(sticker — 可莉姆船长: a small captain looking worried | id:CAAC)");
    expect(result).not.toContain("☹️");
  });

  it("sticker 无 description 时 alt emoji 作为兜底显示", () => {
    const result = formatStickerMediaText({
      emoji: "☹️",
      title: "可莉姆船长",
      fileId: "CAAC",
    });

    expect(result).toBe("(sticker ☹️ — 可莉姆船长 | id:CAAC)");
  });

  it("无 segments 回退到 200 字符硬截断", () => {
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: "X".repeat(300),
      date: new Date(),
    };
    const result = renderMessageContent(record);
    expect(result).toBe(`${"X".repeat(200)}...`);
  });

  it("无 segments 且 text ≤ 200 → 完整返回", () => {
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: "short text",
      date: new Date(),
    };
    expect(renderMessageContent(record)).toBe("short text");
  });

  it("有 media segment 时预算 500 chars", () => {
    const body = "B".repeat(400);
    const media = "(photo: a beautiful sunset over the ocean)";
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: `${body} ${media}`,
      date: new Date(),
      segments: [
        { kind: "body", text: body },
        { kind: "media", text: media },
      ],
    };
    const result = renderMessageContent(record);
    // body + media 总长 < 500，应完整保留
    expect(result).toBe(`${body} ${media}`);
  });

  it("photo OCR 显式标记为图片文字，不伪装成发送者正文", () => {
    const ocr = "Alice online: 周末想去拍照";
    const media = "(photo 📷)";
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: `${media} ${ocr}`,
      date: new Date(),
      segments: [
        { kind: "media", text: media },
        { kind: "meta", text: formatImageOcrMetaText(ocr) },
      ],
    };

    const result = renderMessageContent(record);

    expect(result).toContain("image OCR text");
    expect(result).toContain("not sender speech");
    expect(result).toContain(ocr);
    expect(result).not.toContain(`(text: "${ocr}")`);
  });

  it("超限时先丢弃 link，保留 media/image", () => {
    const body = "B".repeat(300);
    const link = `(link: ${"L".repeat(200)})`;
    const media = "(photo: description of photo)";
    // body(300) + link(208) + media(29) = 540 > 500（media 预算）
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: `${body} ${link} ${media}`,
      date: new Date(),
      segments: [
        { kind: "body", text: body },
        { kind: "link", text: link },
        { kind: "media", text: media },
      ],
    };
    const result = renderMessageContent(record);
    // link 应被丢弃，body + media 保留（body(300) + media(29) = 331 < 500）
    expect(result).toContain(media);
    expect(result).not.toContain("link:");
    expect(result).toContain(body);
  });

  it("纯文本 body（有 segments 但无 media）仍截断到 200", () => {
    const body = "T".repeat(300);
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: body,
      date: new Date(),
      segments: [{ kind: "body", text: body }],
    };
    const result = renderMessageContent(record);
    expect(result).toBe(`${"T".repeat(200)}...`);
  });

  it("media/image 段永远不被截断", () => {
    const longBody = "B".repeat(500);
    const media = `(photo: ${"D".repeat(200)})`;
    const image = `(image: ${"I".repeat(200)})`;
    const record: MessageRecord = {
      id: 1,
      senderName: "Bob",
      isOutgoing: false,
      text: `${longBody} ${media} ${image}`,
      date: new Date(),
      segments: [
        { kind: "body", text: longBody },
        { kind: "media", text: media },
        { kind: "image", text: image },
      ],
    };
    const result = renderMessageContent(record);
    // media 和 image 完整保留
    expect(result).toContain(media);
    expect(result).toContain(image);
    // body 被截断
    expect(result).not.toContain(longBody);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ThoughtTimelineSource
// ═══════════════════════════════════════════════════════════════════════════

describe("ThoughtTimelineSource", () => {
  const mockGetRecent = vi.mocked(getRecentActionsByChat);

  beforeEach(() => {
    mockGetRecent.mockReset();
  });

  it("基本格式 — * reasoning（不含 actionType 后缀）", () => {
    const now = Date.now();
    mockGetRecent.mockReturnValue([
      {
        tick: 1,
        reasoning: "这是一段推理文本",
        actionType: "reply",
        createdAt: new Date(now - 5000),
      },
    ]);

    const source = new ThoughtTimelineSource();
    const entries = source.entries("channel:1", now - 600_000, now);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thought");
    expect(entries[0].rendered).toBe("* 这是一段推理文本");
    expect(entries[0].ts).toBe(now - 5000);
  });

  it("reasoning 超 120 字符截断", () => {
    const now = Date.now();
    const longReasoning = "字".repeat(200);
    mockGetRecent.mockReturnValue([
      {
        tick: 1,
        reasoning: longReasoning,
        actionType: "reply",
        createdAt: new Date(now - 1000),
      },
    ]);

    const source = new ThoughtTimelineSource();
    const entries = source.entries("channel:1", now - 600_000, now);

    expect(entries[0].rendered).toContain("字".repeat(120));
    expect(entries[0].rendered).not.toContain("字".repeat(121));
  });

  it("silence 类型 → * [silence] observing（不含 actionType 后缀）", () => {
    const now = Date.now();
    mockGetRecent.mockReturnValue([
      {
        tick: 1,
        reasoning: null,
        actionType: "stay_silent",
        createdAt: new Date(now - 2000),
      },
    ]);

    const source = new ThoughtTimelineSource();
    const entries = source.entries("channel:1", now - 600_000, now);

    expect(entries).toHaveLength(1);
    expect(entries[0].rendered).toBe("* [silence] observing");
  });

  it("actionType 包含 silence 也触发 silence 标记", () => {
    const now = Date.now();
    mockGetRecent.mockReturnValue([
      {
        tick: 1,
        reasoning: null,
        actionType: "group_silence",
        createdAt: new Date(now - 2000),
      },
    ]);

    const source = new ThoughtTimelineSource();
    const entries = source.entries("channel:1", now - 600_000, now);

    expect(entries[0].rendered).toContain("[silence] observing");
  });

  it("reasoning=null 且非 silence → 过滤掉", () => {
    const now = Date.now();
    mockGetRecent.mockReturnValue([
      {
        tick: 1,
        reasoning: null,
        actionType: "reply",
        createdAt: new Date(now - 2000),
      },
    ]);

    const source = new ThoughtTimelineSource();
    const entries = source.entries("channel:1", now - 600_000, now);

    expect(entries).toHaveLength(0);
  });

  it("DESC → reverse 顺序验证", () => {
    const now = Date.now();
    mockGetRecent.mockReturnValue([
      { tick: 3, reasoning: "third", actionType: "reply", createdAt: new Date(now - 1000) },
      { tick: 2, reasoning: "second", actionType: "reply", createdAt: new Date(now - 2000) },
      { tick: 1, reasoning: "first", actionType: "reply", createdAt: new Date(now - 3000) },
    ]);

    const source = new ThoughtTimelineSource();
    const entries = source.entries("channel:1", now - 600_000, now);

    expect(entries[0].rendered).toContain("first");
    expect(entries[1].rendered).toContain("second");
    expect(entries[2].rendered).toContain("third");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ObservationTimelineSource
// ═══════════════════════════════════════════════════════════════════════════

describe("ObservationTimelineSource", () => {
  it("基本格式（非跨聊天）— 块级标记包裹", () => {
    const source = new ObservationTimelineSource(["query result 1", "query result 2"]);
    const entries = source.entries("channel:1", 0, 42000);

    // ADR-196 F16: 块级标记替代逐行 [observation] 前缀
    // header + 2 obs + footer = 4
    expect(entries).toHaveLength(4);
    expect(entries[0].kind).toBe("context");
    expect(entries[0].rendered).toBe("--- observations ---");
    expect(entries[1]).toEqual({
      ts: 42000,
      kind: "observation",
      rendered: "query result 1",
    });
    expect(entries[2]).toEqual({
      ts: 42000,
      kind: "observation",
      rendered: "query result 2",
    });
    expect(entries[3].kind).toBe("context");
    expect(entries[3].rendered).toBe("--- end observations ---");
  });

  it("空观察列表 → 空 entries", () => {
    const source = new ObservationTimelineSource([]);
    expect(source.entries("channel:1", 0, 1000)).toEqual([]);
  });

  // ADR-160 Fix D: 跨聊天观察隔离
  it("跨聊天 recentChat → context 包裹", () => {
    const obs = "[recent_chat]\n--- 10 messages from 葱群 ---\n[5m ago] Bob: 你好";
    const source = new ObservationTimelineSource([obs]);
    const entries = source.entries("channel:123", 0, 42000);

    // 3 entries: header + observation + footer（跨聊天保持独立包裹）
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe("context");
    expect(entries[0].rendered).toContain("cross-chat reference");
    expect(entries[0].rendered).toContain("do NOT reply");
    expect(entries[1].kind).toBe("observation");
    expect(entries[1].rendered).toContain("recent_chat");
    expect(entries[2].kind).toBe("context");
    expect(entries[2].rendered).toBe("--- end cross-chat ---");
  });

  it("同聊天 recentChat → observations 块级包裹（非 cross-chat）", () => {
    // observation 包含 target channel ID → 不算跨聊天，进入普通 observations 块
    const obs = "[recent_chat] channel:123\n--- messages from 当前群 ---";
    const source = new ObservationTimelineSource([obs]);
    const entries = source.entries("channel:123", 0, 42000);

    // ADR-196 F16: 块级标记 header + obs + footer = 3
    expect(entries).toHaveLength(3);
    expect(entries[0].rendered).toBe("--- observations ---");
    expect(entries[1].kind).toBe("observation");
    expect(entries[2].rendered).toBe("--- end observations ---");
  });

  it("混合跨聊天和非跨聊天 observations", () => {
    const observations = [
      "普通查询结果",
      "[recent_chat]\n--- 5 messages from 其他群 ---\nAlice: hi",
      "另一个普通结果",
    ];
    const source = new ObservationTimelineSource(observations);
    const entries = source.entries("channel:1", 0, 42000);

    // ADR-196 F16: 跨聊天独立包裹(3) + 普通块级包裹(2 obs + header + footer = 4) = 7
    expect(entries).toHaveLength(7);
    // 跨聊天先输出（遍历顺序：先处理跨聊天，再输出普通块）
    expect(entries[0].kind).toBe("context"); // cross-chat header
    expect(entries[1].kind).toBe("observation"); // cross-chat obs
    expect(entries[2].kind).toBe("context"); // cross-chat footer
    // 普通 observations 块
    expect(entries[3].rendered).toBe("--- observations ---");
    expect(entries[4].kind).toBe("observation"); // 普通 1
    expect(entries[5].kind).toBe("observation"); // 普通 2
    expect(entries[6].rendered).toBe("--- end observations ---");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildTimeline — 归并排序 + 全局 gap 注入
// ═══════════════════════════════════════════════════════════════════════════

describe("buildTimeline", () => {
  it("混合 4 种 source 按 ts 归并排序", () => {
    const sources = [
      { entries: () => [{ ts: 300, kind: "message" as const, rendered: "msg" }] },
      { entries: () => [{ ts: 100, kind: "thought" as const, rendered: "thought" }] },
      { entries: () => [{ ts: 400, kind: "action" as const, rendered: "action" }] },
      { entries: () => [{ ts: 200, kind: "observation" as const, rendered: "obs" }] },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, 1000);

    // 不计 gap/context（day change 标记属于 context）
    const content = timeline.filter((e) => e.kind !== "gap" && e.kind !== "context");
    expect(content).toHaveLength(4);
    expect(content.map((e) => e.ts)).toEqual([100, 200, 300, 400]);
    expect(content.map((e) => e.kind)).toEqual(["thought", "observation", "message", "action"]);
  });

  it("同一 ts 的 entries 保持推入顺序（stable sort）", () => {
    const sources = [
      {
        entries: () => [
          { ts: 100, kind: "context" as const, rendered: "first" },
          { ts: 100, kind: "message" as const, rendered: "second" },
        ],
      },
      { entries: () => [{ ts: 100, kind: "thought" as const, rendered: "third" }] },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, 1000);

    // day change 会在 message/thought 前插入 context，但 context 类型的 "first" 不触发
    const rendered = timeline.map((e) => e.rendered);
    // "first" (context) 不触发 day change，但 "second" (message) 会
    expect(rendered).toContain("first");
    expect(rendered).toContain("second");
    expect(rendered).toContain("third");
    // context/message/thought 的相对顺序保持
    const nonDayChange = rendered.filter((r) => !r.startsWith("--- Day changed"));
    expect(nonDayChange).toEqual(["first", "second", "third"]);
  });

  it("空 sources → 空时间线", () => {
    expect(buildTimeline([], "channel:1", 0, 1000)).toEqual([]);
  });

  // ── 全局 gap 注入测试 ──────────────────────────────────────────────

  it("相邻条目 ≥30min gap → 注入 gap 标记", () => {
    const t0 = 0;
    const t1 = 45 * 60_000; // +45min
    const t2 = t1 + 150 * 60_000; // +150min (2.5h)
    const sources = [
      {
        entries: () => [
          { ts: t0, kind: "message" as const, rendered: "msg1" },
          { ts: t1, kind: "message" as const, rendered: "msg2" },
          { ts: t2, kind: "message" as const, rendered: "msg3" },
        ],
      },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, t2 + 1);
    const gaps = timeline.filter((e) => e.kind === "gap");

    expect(gaps).toHaveLength(2);
    expect(gaps[0].rendered).toBe("--- 45m gap ---");
    expect(gaps[1].rendered).toBe("--- 3h gap ---");
  });

  it("相邻条目 < 30min → 不注入 gap", () => {
    const t0 = 0;
    const t1 = 20 * 60_000; // +20min
    const sources = [
      {
        entries: () => [
          { ts: t0, kind: "message" as const, rendered: "msg1" },
          { ts: t1, kind: "message" as const, rendered: "msg2" },
        ],
      },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, t1 + 1);

    expect(timeline.filter((e) => e.kind === "gap")).toHaveLength(0);
  });

  it("跨源 gap 检测 — 消息和思考之间的 gap", () => {
    const msgTs = 0;
    const thoughtTs = 60 * 60_000; // 消息后 1 小时
    const sources = [
      { entries: () => [{ ts: msgTs, kind: "message" as const, rendered: "msg" }] },
      { entries: () => [{ ts: thoughtTs, kind: "thought" as const, rendered: "thought" }] },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, thoughtTs + 1);

    const gaps = timeline.filter((e) => e.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].rendered).toBe("--- 60m gap ---");
    // gap 在消息和思考之间（过滤 day change context）
    const kinds = timeline
      .filter((e) => !(e.kind === "context" && e.rendered.startsWith("--- Day changed")))
      .map((e) => e.kind);
    expect(kinds).toEqual(["message", "gap", "thought"]);
  });

  it("单条目时间线 — 不注入 gap", () => {
    const sources = [{ entries: () => [{ ts: 100, kind: "message" as const, rendered: "only" }] }];
    const timeline = buildTimeline(sources, "channel:1", 0, 1000);

    // 过滤 day change context
    const content = timeline.filter((e) => e.kind !== "context");
    expect(content).toHaveLength(1);
    expect(content[0].rendered).toBe("only");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderTimeline — 统一时间戳脊柱
// ═══════════════════════════════════════════════════════════════════════════

describe("renderTimeline", () => {
  // 12h 格式：`6:00 PM`、`11:21 AM`
  const TIME_RE = /\d{1,2}:\d{2}\s[AP]M/;

  it("内容条目添加 [h:MM AM/PM] 前缀", () => {
    const ts = new Date("2025-06-01T10:00:00Z").getTime();
    const time = new Date(ts).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "UTC",
    });
    const entries: TimelineEntry[] = [
      { ts, kind: "message", rendered: "Alice (you) (msgId 1): hi" },
      { ts: ts + 60_000, kind: "thought", rendered: "* thinking about reply" },
      { ts: ts + 120_000, kind: "message", rendered: "Alice (you): hello" },
      { ts: ts + 180_000, kind: "observation", rendered: "[observation] result" },
    ];
    const lines = renderTimeline(entries);

    for (const line of lines) {
      expect(line).toMatch(TIME_RE);
    }
    expect(lines[0]).toBe(`[${time}] Alice (you) (msgId 1): hi`);
  });

  it("结构条目（gap/context）不添加时间戳前缀", () => {
    const entries: TimelineEntry[] = [
      { ts: 1000, kind: "gap", rendered: "--- 30m gap ---" },
      { ts: 2000, kind: "context", rendered: "--- context: reply chain ---" },
    ];
    const lines = renderTimeline(entries);

    expect(lines[0]).toBe("--- 30m gap ---");
    expect(lines[1]).toBe("--- context: reply chain ---");
    for (const line of lines) {
      expect(line).not.toMatch(TIME_RE);
    }
  });

  it("空 entries → 空数组", () => {
    expect(renderTimeline([])).toEqual([]);
  });

  it("提供 nowMs 时，旧消息追加相对时间标签", () => {
    const ts = new Date("2025-06-01T10:00:00Z").getTime();
    const nowMs = ts + 3 * 60 * 60_000; // 3 小时后
    const entries: TimelineEntry[] = [
      { ts, kind: "message", rendered: "Alice (you) (msgId 1): hi" },
      { ts: nowMs - 10_000, kind: "message", rendered: "Bob (msgId 2): hello" },
    ];
    const lines = renderTimeline(entries, nowMs);

    // 3h 前的消息带相对标签
    expect(lines[0]).toMatch(/~3h ago\]/);
    expect(lines[0]).toMatch(TIME_RE);
    // 10s 前的消息不带（< 30min 阈值）
    expect(lines[1]).toMatch(TIME_RE);
    expect(lines[1]).not.toContain("ago");
  });

  it("不提供 nowMs 时，不追加相对时间标签（向后兼容）", () => {
    const ts = new Date("2025-06-01T10:00:00Z").getTime();
    const entries: TimelineEntry[] = [
      { ts, kind: "message", rendered: "Alice (you) (msgId 1): hi" },
    ];
    const lines = renderTimeline(entries);

    expect(lines[0]).toMatch(TIME_RE);
    expect(lines[0]).not.toContain("ago");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Day change + Tail gap — 时间感知增强
// ═══════════════════════════════════════════════════════════════════════════

describe("buildTimeline — day change 标记", () => {
  it("跨日消息插入 IRC 风格 day change 分隔线", () => {
    // 用本地时区安全的时间差（间隔 24h 确保跨日）
    const day1 = new Date("2025-06-01T12:00:00Z").getTime();
    const day2 = new Date("2025-06-02T12:00:00Z").getTime();
    const sources = [
      {
        entries: () => [
          { ts: day1, kind: "message" as const, rendered: "msg1" },
          { ts: day2, kind: "message" as const, rendered: "msg2" },
        ],
      },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, day2 + 1);

    const dayChanges = timeline.filter(
      (e) => e.kind === "context" && e.rendered.startsWith("--- Day changed"),
    );
    // 两条消息各有一个 day change（首条也有）
    expect(dayChanges).toHaveLength(2);
    // 不断言具体日期名（受本地时区影响），只验证存在两个不同的 day change
    expect(dayChanges[0].rendered).not.toBe(dayChanges[1].rendered);
  });

  it("同日消息只插入一个 day change", () => {
    const t1 = new Date("2025-06-01T10:00:00Z").getTime();
    const t2 = new Date("2025-06-01T10:05:00Z").getTime();
    const sources = [
      {
        entries: () => [
          { ts: t1, kind: "message" as const, rendered: "msg1" },
          { ts: t2, kind: "message" as const, rendered: "msg2" },
        ],
      },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, t2 + 1);

    const dayChanges = timeline.filter(
      (e) => e.kind === "context" && e.rendered.startsWith("--- Day changed"),
    );
    expect(dayChanges).toHaveLength(1);
  });
});

describe("buildTimeline — tail gap", () => {
  it("最后消息距 nowMs ≥30min 时注入尾部 gap", () => {
    const msgTs = new Date("2025-06-01T10:00:00Z").getTime();
    const nowMs = msgTs + 3 * 60 * 60_000; // 3 小时后
    const sources = [
      {
        entries: () => [{ ts: msgTs, kind: "message" as const, rendered: "msg" }],
      },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, nowMs);

    const tailGaps = timeline.filter(
      (e) => e.kind === "gap" && e.rendered.includes("since last message"),
    );
    expect(tailGaps).toHaveLength(1);
    expect(tailGaps[0].rendered).toBe("--- 3h since last message ---");
  });

  it("最后消息距 nowMs <30min 时不注入尾部 gap", () => {
    const msgTs = new Date("2025-06-01T10:00:00Z").getTime();
    const nowMs = msgTs + 10 * 60_000; // 10 分钟后
    const sources = [
      {
        entries: () => [{ ts: msgTs, kind: "message" as const, rendered: "msg" }],
      },
    ];
    const timeline = buildTimeline(sources, "channel:1", 0, nowMs);

    const tailGaps = timeline.filter(
      (e) => e.kind === "gap" && e.rendered.includes("since last message"),
    );
    expect(tailGaps).toHaveLength(0);
  });
});
