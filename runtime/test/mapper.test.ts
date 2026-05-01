/**
 * applyPerturbation 单元测试 — Telegram 事件到图状态映射。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import {
  applyPerturbation,
  applyPerturbations,
  cleanupPhantomContacts,
  type GraphPerturbation,
} from "../src/telegram/mapper.js";

/** 创建含 self 节点的图（mapper 依赖 self 做自动关联）。 */
function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  return G;
}

describe("applyPerturbation", () => {
  let G: WorldModel;

  beforeEach(() => {
    G = makeGraph();
  });

  // -- new_message --------------------------------------------------------------

  describe("new_message", () => {
    it("新频道自动建节点并关联 self", () => {
      expect(G.has("channel:100")).toBe(false);
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        tick: 1,
        chatType: "private",
      });

      expect(G.has("channel:100")).toBe(true);
      expect(G.getChannel("channel:100").chat_type).toBe("private");
      expect(G.getNeighbors("self", "monitors")).toContain("channel:100");
    });

    it("新联系人自动建节点并关联 self + 频道", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:10042",
        displayName: "Bob",
        tick: 1,
        chatType: "private",
      });

      expect(G.has("contact:10042")).toBe(true);
      expect(G.getContact("contact:10042").display_name).toBe("Bob");
      expect(G.getNeighbors("self", "acquaintance")).toContain("contact:10042");
      expect(G.getNeighbors("contact:10042", "joined")).toContain("channel:100");
    });

    it("已存在的节点不重复创建", () => {
      G.addChannel("channel:100", { chat_type: "group" });
      G.addContact("contact:10042", { display_name: "Bob" });

      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:10042",
        tick: 1,
      });

      // 只增加了 conversation 节点（如有），不应重复 channel/contact
      expect(G.getChannel("channel:100").chat_type).toBe("group"); // 保留原值
    });

    it("unread 累加", () => {
      applyPerturbation(G, { type: "new_message", channelId: "channel:100", tick: 1 });
      expect(G.getChannel("channel:100").unread).toBe(1);

      applyPerturbation(G, { type: "new_message", channelId: "channel:100", tick: 2 });
      expect(G.getChannel("channel:100").unread).toBe(2);
    });

    it("directed 消息更新 pending_directed 和 last_directed_ms", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        isDirected: true,
        tick: 5,
        nowMs: 1000005,
      });

      const attrs = G.getChannel("channel:100");
      expect(attrs.pending_directed).toBe(1);
      expect(attrs.last_directed_ms).toBe(1000005);
    });

    it("非 directed 消息不更新 pending_directed", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        isDirected: false,
        tick: 5,
      });
      expect(G.getChannel("channel:100").pending_directed).toBe(0);
    });

    it("bot directed 消息不递增 pending_directed（防 AI-AI 循环）", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:bot",
        isDirected: true,
        senderIsBot: true,
        tick: 5,
        nowMs: 1000005,
      });
      // bot 的 directed 消息（reply/@mention/私聊）不产生社交义务
      expect(G.getChannel("channel:100").pending_directed).toBe(0);
      // 但 bot 标记仍正常写入
      expect(G.getChannel("channel:100").last_sender_is_bot).toBe(true);
      expect(G.getContact("contact:bot").is_bot).toBe(true);
      // unread 仍累加（ambient awareness）
      expect(G.getChannel("channel:100").unread).toBe(1);
    });

    it("chatType=private 时 tier_contact=50", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:p",
        chatType: "private",
        tick: 1,
      });
      expect(G.getChannel("channel:p").tier_contact).toBe(50);
    });

    it("chatType=group 时 tier_contact=150", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:g",
        chatType: "group",
        tick: 1,
      });
      expect(G.getChannel("channel:g").tier_contact).toBe(150);
    });

    it("chatType=supergroup 时 tier_contact=150", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:sg",
        chatType: "supergroup",
        tick: 1,
      });
      expect(G.getChannel("channel:sg").tier_contact).toBe(150);
    });

    it("senderIsBot=true 标记 contact 和 channel", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:bot",
        senderIsBot: true,
        tick: 1,
      });

      expect(G.getContact("contact:bot").is_bot).toBe(true);
      expect(G.getChannel("channel:100").last_sender_is_bot).toBe(true);
    });

    it("非 bot 消息清除 channel 的 last_sender_is_bot", () => {
      // 先发 bot 消息
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:bot",
        senderIsBot: true,
        tick: 1,
      });
      expect(G.getChannel("channel:100").last_sender_is_bot).toBe(true);

      // 非 bot 消息覆盖
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:human",
        tick: 2,
      });
      expect(G.getChannel("channel:100").last_sender_is_bot).toBe(false);
    });

    it("mentions_alice 检测（大小写不敏感）", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        messageText: "Hey ALICE, how are you?",
        tick: 1,
      });
      expect(G.getChannel("channel:100").mentions_alice).toBe(true);
    });

    it("无 Alice 提及时不设置 mentions_alice", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        messageText: "Hello world",
        tick: 1,
      });
      expect(G.getChannel("channel:100").mentions_alice).toBeFalsy();
    });

    it("更新联系人 last_active_ms 和 interaction_count", () => {
      G.addContact("contact:100");
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:100",
        tick: 10,
        nowMs: 1000010,
      });

      expect(G.getContact("contact:100").last_active_ms).toBe(1000010);
      expect(G.getContact("contact:100").interaction_count).toBe(1);

      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:100",
        tick: 20,
        nowMs: 1000020,
      });
      expect(G.getContact("contact:100").interaction_count).toBe(2);
    });

    it("returning contact 检测（沉默超过半个 theta）", () => {
      // ADR-113: tier=150, theta=172800s, 半 theta=86400s
      G.addContact("contact:r", { tier: 150, last_active_ms: 100_000 });
      // nowMs=100_000_000: silence=(100_000_000-100_000)/1000=99900s > 86400 → 标记 returning
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        contactId: "contact:r",
        tick: 2600,
        nowMs: 100_000_000,
      });
      expect(G.getContact("contact:r").returning_ms).toBe(100_000_000);
    });

    it("L3: contentType 标记", () => {
      applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:100",
        tick: 1,
        contentType: "sticker",
      });
      expect(G.getChannel("channel:100").last_content_type).toBe("sticker");
    });

    it("默认 contentType 为 text", () => {
      applyPerturbation(G, { type: "new_message", channelId: "channel:100", tick: 1 });
      expect(G.getChannel("channel:100").last_content_type).toBe("text");
    });

    it("返回 event.novelty 或默认 0.5", () => {
      const n1 = applyPerturbation(G, {
        type: "new_message",
        channelId: "channel:a",
        tick: 1,
        novelty: 0.8,
      });
      expect(n1).toBe(0.8);

      const n2 = applyPerturbation(G, { type: "new_message", channelId: "channel:b", tick: 2 });
      expect(n2).toBe(0.5);
    });
  });

  // -- read_history -------------------------------------------------------------

  describe("read_history", () => {
    it("清空 unread 但保留 pending_directed", () => {
      G.addChannel("channel:100", { unread: 5, pending_directed: 2 });
      applyPerturbation(G, { type: "read_history", channelId: "channel:100", tick: 10 });

      expect(G.getChannel("channel:100").unread).toBe(0);
      // pending_directed 不随 read_history 清零——已读 ≠ 已回复
      expect(G.getChannel("channel:100").pending_directed).toBe(2);
    });

    it("清除 mentions_alice 标记", () => {
      G.addChannel("channel:100");
      G.setDynamic("channel:100", "mentions_alice", true);

      applyPerturbation(G, { type: "read_history", channelId: "channel:100", tick: 10 });
      expect(G.getChannel("channel:100").mentions_alice).toBe(false);
    });

    it("不存在的 channel 不崩溃", () => {
      const n = applyPerturbation(G, {
        type: "read_history",
        channelId: "channel:ghost",
        tick: 10,
      });
      expect(n).toBe(0.05);
    });

    it("返回 0.05", () => {
      G.addChannel("channel:100");
      const n = applyPerturbation(G, { type: "read_history", channelId: "channel:100", tick: 10 });
      expect(n).toBe(0.05);
    });
  });

  // -- user_status --------------------------------------------------------------

  describe("user_status", () => {
    it("更新联系人 last_active_ms", () => {
      G.addContact("contact:100", { last_active_ms: 0 });
      applyPerturbation(G, {
        type: "user_status",
        contactId: "contact:100",
        tick: 42,
        nowMs: 1000042,
      });
      expect(G.getContact("contact:100").last_active_ms).toBe(1000042);
    });

    it("不存在的联系人不崩溃", () => {
      const n = applyPerturbation(G, { type: "user_status", contactId: "contact:ghost", tick: 42 });
      expect(n).toBe(0.1);
    });

    it("返回 0.1", () => {
      G.addContact("contact:100");
      const n = applyPerturbation(G, { type: "user_status", contactId: "contact:100", tick: 1 });
      expect(n).toBe(0.1);
    });
  });

  // -- contact_active -----------------------------------------------------------

  describe("contact_active", () => {
    it("更新联系人 last_active_ms", () => {
      G.addContact("contact:100");
      applyPerturbation(G, {
        type: "contact_active",
        contactId: "contact:100",
        tick: 30,
        nowMs: 1000030,
      });
      expect(G.getContact("contact:100").last_active_ms).toBe(1000030);
    });

    it("返回 0.2", () => {
      G.addContact("contact:100");
      const n = applyPerturbation(G, { type: "contact_active", contactId: "contact:100", tick: 1 });
      expect(n).toBe(0.2);
    });
  });

  // -- reaction -----------------------------------------------------------------

  describe("reaction", () => {
    it("自动建 contact 并更新 reaction 属性", () => {
      applyPerturbation(G, {
        type: "reaction",
        channelId: "channel:100",
        contactId: "contact:99",
        tick: 10,
        emoji: "\u{1F44D}",
        messageId: 42,
        nowMs: 1000010,
      });

      expect(G.has("contact:99")).toBe(true);
      expect(G.getContact("contact:99").last_reaction_ms).toBe(1000010);
      expect(G.getContact("contact:99").last_reaction_emoji).toBe("\u{1F44D}");
      expect(G.getContact("contact:99").reaction_boost_ms).toBe(1000010);
    });

    it("自动建 channel 并更新 last_reaction_ms", () => {
      applyPerturbation(G, {
        type: "reaction",
        channelId: "channel:200",
        tick: 15,
        emoji: "\u{2764}",
        nowMs: 1000015,
      });
      expect(G.has("channel:200")).toBe(true);
      expect(G.getChannel("channel:200").last_reaction_ms).toBe(1000015);
    });

    it("无 emoji 时不 push（仅 contact/channel 节点影响）", () => {
      // applyPerturbation 本身不检查 emoji 是否为空（caller 负责），
      // 但 emoji 默认为 ""
      applyPerturbation(G, {
        type: "reaction",
        channelId: "channel:100",
        contactId: "contact:100",
        tick: 1,
      });
      expect(G.getContact("contact:100").last_reaction_emoji).toBe("");
    });

    it("返回 0.3", () => {
      const n = applyPerturbation(G, {
        type: "reaction",
        channelId: "channel:100",
        tick: 1,
        emoji: "!",
      });
      expect(n).toBe(0.3);
    });
  });

  // -- 未知事件类型 ---------------------------------------------------------------

  describe("default branch", () => {
    it("返回默认 novelty 0.05，不崩溃", () => {
      const n = applyPerturbation(G, {
        type: "some_future_event" as GraphPerturbation["type"],
        tick: 1,
      });
      expect(n).toBe(0.05);
    });
  });
});

// -- applyPerturbations 批量 ---------------------------------------------------

describe("applyPerturbations", () => {
  it("空事件数组返回 0.05", () => {
    const G = makeGraph();
    expect(applyPerturbations(G, [])).toBe(0.05);
  });

  it("返回平均 novelty", () => {
    const G = makeGraph();
    G.addChannel("channel:1");
    G.addContact("contact:100");

    const events: GraphPerturbation[] = [
      { type: "new_message", channelId: "channel:1", tick: 1, novelty: 0.8 },
      { type: "user_status", contactId: "contact:100", tick: 1 }, // 0.1
    ];
    const avg = applyPerturbations(G, events);
    expect(avg).toBeCloseTo((0.8 + 0.1) / 2, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-206: 频道幽灵联系人隔离
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-206: channel phantom contact isolation", () => {
  let G: WorldModel;

  beforeEach(() => {
    G = makeGraph();
  });

  it("频道以自身身份发消息 → 不创建 contact 节点", () => {
    // 频道 sender_id === chat_id（channel:telegram:100 以自身身份发帖）
    applyPerturbation(G, {
      type: "new_message",
      channelId: "channel:telegram:100",
      contactId: "contact:telegram:100",
      chatType: "channel",
      displayName: "测试用户🦊",
      tick: 1,
    });

    // channel 节点应存在
    expect(G.has("channel:telegram:100")).toBe(true);
    // phantom contact 不应被创建
    expect(G.has("contact:telegram:100")).toBe(false);
  });

  it("频道中真人管理员发消息 → 正常创建 contact 节点", () => {
    // 管理员的 sender_id !== chat_id
    applyPerturbation(G, {
      type: "new_message",
      channelId: "channel:-1009900000001",
      contactId: "contact:1002345678",
      chatType: "channel",
      displayName: "Admin",
      tick: 1,
    });

    // 管理员 contact 应存在
    expect(G.has("contact:1002345678")).toBe(true);
    expect(G.getContact("contact:1002345678").display_name).toBe("Admin");
  });

  it("非频道消息 → 正常创建 contact 节点", () => {
    applyPerturbation(G, {
      type: "new_message",
      channelId: "channel:100",
      contactId: "contact:10000",
      chatType: "private",
      displayName: "Bob",
      tick: 1,
    });

    // 私聊中 sender_id === chat_id 也应创建 contact
    expect(G.has("contact:10000")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-206: 幽灵联系人清理
// ═══════════════════════════════════════════════════════════════════════════

describe("cleanupPhantomContacts", () => {
  it("删除频道幽灵联系人", () => {
    const G = makeGraph();
    G.addChannel("channel:telegram:100", { chat_type: "channel" });
    G.addContact("contact:telegram:100", { tier: 50, display_name: "测试用户🦊" });
    G.addRelation("self", "acquaintance", "contact:telegram:100");

    const cleaned = cleanupPhantomContacts(G);

    expect(cleaned).toBe(1);
    expect(G.has("contact:telegram:100")).toBe(false);
    // channel 节点应保留
    expect(G.has("channel:telegram:100")).toBe(true);
  });

  it("不删除私聊联系人", () => {
    const G = makeGraph();
    G.addChannel("channel:100", { chat_type: "private" });
    G.addContact("contact:10000", { tier: 50, display_name: "Bob" });

    const cleaned = cleanupPhantomContacts(G);

    expect(cleaned).toBe(0);
    expect(G.has("contact:10000")).toBe(true);
  });

  it("不删除群聊联系人", () => {
    const G = makeGraph();
    G.addChannel("channel:-1001234", { chat_type: "supergroup" });
    G.addContact("contact:-1001234", { tier: 50 });

    const cleaned = cleanupPhantomContacts(G);

    expect(cleaned).toBe(0);
    expect(G.has("contact:-1001234")).toBe(true);
  });

  it("无对应 channel 节点的联系人不受影响", () => {
    const G = makeGraph();
    G.addContact("contact:99999", { tier: 50 });

    const cleaned = cleanupPhantomContacts(G);

    expect(cleaned).toBe(0);
    expect(G.has("contact:99999")).toBe(true);
  });
});
