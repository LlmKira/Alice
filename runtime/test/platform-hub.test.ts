/**
 * PlatformHub 的契约测试：把 QQPlatform（连假的 OneBot 服务端）和一个模拟的 Telegram 平台挂进同一个
 * PlatformHub，验证：事件和动作按会话前缀分到对应平台；提示词和意愿层按会话所在平台的能力取舍动作；
 * 多平台配置的解析，以及启动和停机。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, operatorScopes } from "../src/config.js";
import { closeDb, initDb } from "../src/db/connection.js";
import {
  emptyWorld,
  intentionsFor,
  PRODUCTION,
  willWake,
  worldFold,
} from "../src/mechanisms/pressure/index.js";
import { productionMechanisms } from "../src/mechanisms/registry.js";
import {
  type Act,
  affordances,
  PLATFORM_ACT_KINDS,
  type PlatformActKind,
} from "../src/mind/affordances.js";
import type { AliceEvent, MessageReceived } from "../src/mind/events.js";
import { Failed } from "../src/mind/failure.js";
import { emptyChat, emptyState } from "../src/mind/state.js";
import { speechRequest } from "../src/mind/step.js";
import { Operator } from "../src/ops/operator.js";
import { SpendMeter } from "../src/ops/spend.js";
import type { Platform, PlatformHost } from "../src/platform.js";
import { PlatformHub } from "../src/platform-hub.js";
import type { SocketLike } from "../src/qq/client.js";
import { QQPlatform } from "../src/qq/platform.js";
import { rotationOf } from "../src/sim/will-arms.js";
import { upsertStickerPerception } from "../src/sticker-palette.js";
import { fakeGateway } from "./fake-gateway.js";

const T0 = 1_771_000_000_000;

function fakeOneBotConnect(
  onRequest: (action: string, params: Record<string, unknown>) => unknown,
) {
  return (): SocketLike => {
    const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    const emit = (type: string, event: { data?: unknown } = {}) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    };
    queueMicrotask(() => emit("open"));
    return {
      send: (raw) => {
        const req = JSON.parse(raw) as {
          action: string;
          params: Record<string, unknown>;
          echo: string;
        };
        const data = onRequest(req.action, req.params);
        queueMicrotask(() =>
          emit("message", {
            data: JSON.stringify({ status: "ok", retcode: 0, data, echo: req.echo }),
          }),
        );
      },
      close: () => emit("close"),
      addEventListener: (type, fn) => {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
    };
  };
}

function makeFakeTelegram() {
  const observed: Array<{ event: AliceEvent; phase: "fold" | "live" }> = [];
  const acted: Array<{ scope: string; act: Act }> = [];
  let stopped = false;
  const platform: Platform = {
    name: "telegram",
    prefix: "telegram:",
    capabilities: {
      acts: new Set<PlatformActKind>(PLATFORM_ACT_KINDS.filter((k) => k !== "unsend")),
    },
    observe: (event, _state, phase) => {
      observed.push({ event, phase });
    },
    startupInfo: () => ({ stickers: 12 }),
    start: async (host) => {
      host.connection("connected");
      return { selfId: "999" };
    },
    act: async (scope, act) => {
      acted.push({ scope, act });
      return { kind: "posted", messageId: "tg-1" };
    },
    query: async () => ({ value: [], result: "none" }),
    stickers: () => ["happy"],
    sendToOperator: async () => {},
    selftest: async () => "贴纸：发出去了",
    stop: async () => {
      stopped = true;
    },
  };
  return { platform, observed, acted, isStopped: () => stopped };
}

function makeHost(): PlatformHost {
  return {
    dispatch: () => {},
    now: () => T0,
    state: () => emptyState,
    pause: { paused: false, onPause: () => {} },
    perceive: {
      image: async () => "图",
      gif: async () => "动图",
      video: async () => "视频",
      voice: async () => "语音",
      sticker: async () => "贴纸",
    },
    signal: new AbortController().signal,
    track: (task) => task,
    connection: () => {},
    warn: () => {},
  };
}

describe("PlatformHub: multi-platform foundation with QQ sample", () => {
  it("routes actions, queries, observations, selftest, and shutdown by scope prefix", async () => {
    // QQ 的自检会发一张贴纸：库里只有一张 Telegram 的，QQ 那边找不到（两个平台的贴纸各管各的）。
    initDb(":memory:");
    upsertStickerPerception({
      fileId: "tg-file",
      fileUniqueId: "u1",
      summary: "开心的猫",
      emotion: "开心",
    });
    const qqCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const qq = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: "20002",
        ignoredSenders: new Set(),
        tts: null,
        connect: fakeOneBotConnect((action, params) => {
          qqCalls.push({ action, params });
          if (action === "get_login_info") return { user_id: 10001, nickname: "Alice" };
          if (action === "send_group_msg") return { message_id: 808 };
          return null;
        }),
      },
    );
    const tg = makeFakeTelegram();
    const hub = new PlatformHub([tg.platform, qq]);

    const { selfIds } = await hub.start(makeHost());
    expect(selfIds).toEqual({ telegram: "999", qq: "10001" });

    const signal = new AbortController().signal;
    expect(
      await hub.act("qq:group:300", { kind: "send", text: "哈喽", replyTo: null }, signal),
    ).toEqual({ kind: "posted", messageId: "808" });
    expect(
      await hub.act("telegram:-100", { kind: "send", text: "hi", replyTo: null }, signal),
    ).toEqual({ kind: "posted", messageId: "tg-1" });
    expect(qqCalls.some((c) => c.action === "send_group_msg")).toBe(true);
    expect(tg.acted).toHaveLength(1);

    await expect(
      hub.act("discord:123", { kind: "send", text: "x", replyTo: null }, signal),
    ).rejects.toMatchObject({ failure: { reason: "peer_unreachable" } });

    // observe 按 scope 只交给负责的平台；全局事件发给所有平台。
    hub.observe(
      {
        type: "message.sent",
        at: T0,
        scope: "qq:group:300",
        messageId: "808",
        text: "哈喽",
        kind: "text",
      },
      emptyState,
      "live",
    );
    expect(tg.observed).toHaveLength(0);
    hub.observe({ type: "clock.tick", at: T0 }, emptyState, "live");
    expect(tg.observed).toHaveLength(1);

    const report = await hub.selftest();
    expect(report).toContain("[telegram]");
    expect(report).toContain("[qq]");
    expect(report).toContain("贴纸：没发出去（invalid_sticker_keyword）");

    await hub.stop();
    expect(tg.isStopped()).toBe(true);
    closeDb();
  });

  it("applies per-scope capabilities simultaneously across Telegram and QQ in speech prompt and will layer", () => {
    const qq = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: "20002",
        ignoredSenders: new Set(),
        tts: null,
      },
    );
    const tg = makeFakeTelegram();
    const hub = new PlatformHub([tg.platform, qq]);
    const resolveCaps = (scope: string) => hub.capabilitiesFor(scope);
    const mechanisms = productionMechanisms(false, resolveCaps);

    const ownLine = {
      at: T0,
      messageId: "50",
      sender: null,
      text: "刚发的",
      contentType: "text",
      replyToMessageId: null,
    };
    const tgGroup = { ...emptyChat("telegram:-100", "group", true), timeline: [ownLine] };
    const qqGroup = { ...emptyChat("qq:group:300", "group", true), timeline: [ownLine] };
    const qqDm = { ...emptyChat("qq:private:40004", "private", true), timeline: [ownLine] };
    const state = {
      ...emptyState,
      chats: {
        "telegram:-100": tgGroup,
        "qq:group:300": qqGroup,
        "qq:private:40004": qqDm,
      },
    };

    const tgReq = speechRequest(state, tgGroup, T0 + 5_000, null, mechanisms);
    expect(tgReq.affordances).toContain("edit");
    expect(tgReq.affordances).toContain("sticker");
    expect(tgReq.affordances).not.toContain("unsend");

    const qqGroupReq = speechRequest(state, qqGroup, T0 + 5_000, null, mechanisms);
    expect(qqGroupReq.affordances).toContain("unsend");
    expect(qqGroupReq.affordances).toContain("react");
    expect(qqGroupReq.affordances).not.toContain("edit");
    expect(qqGroupReq.affordances).toContain("sticker");

    const qqDmReq = speechRequest(state, qqDm, T0 + 5_000, null, mechanisms);
    expect(qqDmReq.affordances).toContain("unsend");
    expect(qqDmReq.affordances).not.toContain("react");

    // 在同一个 World 里，意愿层两边都给 sticker 打分，对 QQ 私聊去掉 react。
    const wake = willWake(affordances, PRODUCTION, undefined, resolveCaps);
    const fold = worldFold(PRODUCTION);
    let world = fold(emptyWorld, {
      type: "message.received",
      at: T0,
      scope: "telegram:-100",
      chatType: "group",
      messageId: "1",
      senderId: "10",
      senderName: "A",
      text: "hi",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    world = fold(world, {
      type: "message.received",
      at: T0,
      scope: "qq:private:40004",
      chatType: "private",
      messageId: "2",
      senderId: "40004",
      senderName: "B",
      text: "在吗",
      contentType: "text",
      replyToMessageId: null,
      directed: true,
    });
    const tgScored = intentionsFor(
      world,
      wake.affordances,
      "telegram:-100",
      T0 + 1_000,
      wake.policy,
    ).map((i) => i.affordance);
    const qqScored = intentionsFor(
      world,
      wake.affordances,
      "qq:private:40004",
      T0 + 1_000,
      wake.policy,
    ).map((i) => i.affordance);
    expect(tgScored).toContain("sticker");
    expect(qqScored).toContain("sticker");
    expect(qqScored).not.toContain("react");

    // stickers(scope) 只返回归属平台的贴纸清单，Telegram 和 QQ 互不串台。
    initDb(":memory:");
    try {
      expect(hub.stickers("telegram:-100")).toEqual(["happy"]);
      expect(hub.stickers("qq:group:300")).toEqual([]);
      expect(hub.stickers("unknown:1")).toEqual([]);
    } finally {
      closeDb();
    }
  });

  it("rejects duplicate platform names or overlapping prefixes", () => {
    const tg1 = makeFakeTelegram().platform;
    const tg2 = makeFakeTelegram().platform;
    expect(() => new PlatformHub([])).toThrow(/at least one/);
    expect(() => new PlatformHub([tg1, tg2])).toThrow(/Duplicate platform/);
  });

  it("loads comma-separated ALICE_PLATFORM=telegram,qq in config", () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-hub-cfg-"));
    const cfgPath = join(dir, "config.toml");
    writeFileSync(cfgPath, "[telegram]\n[speech]\n");
    const cfg = loadRuntimeConfig({
      ALICE_CONFIG_PATH: cfgPath,
      ALICE_PLATFORM: "telegram,qq",
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      TELEGRAM_PHONE: "+10000000000",
      QQ_ONEBOT_WS_URL: "ws://127.0.0.1:3001",
      LLM_API_KEY: "sk-test",
      ALICE_OPERATOR_ID: "42",
      ALICE_TTS: "off",
    });
    expect(cfg.platforms.map((p) => p.name)).toEqual(["telegram", "qq"]);
    expect(cfg.platform.name).toBe("telegram");
  });

  it("rejects unknown scope queries cleanly as Failed unavailable", async () => {
    const tg = makeFakeTelegram().platform;
    const hub = new PlatformHub([tg]);
    let caught: unknown;
    try {
      await hub.query(
        "unknown:1",
        "chat-search",
        { kind: "chat-search", query: "test" },
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Failed);
    expect((caught as Failed).failure.reason).toBe("unavailable");
  });

  it("a QQ that never connects does not hold up hub.start: Telegram starts and acts normally", async () => {
    const qq = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      {
        gateway: fakeGateway(() => ({})),
        operatorId: null,
        ignoredSenders: new Set(),
        tts: null,
        startupGraceMs: 20,
        // SnowLuma 没开：连接一直不打开。
        connect: () => ({ send: () => {}, close: () => {}, addEventListener: () => {} }),
      },
    );
    const tg = makeFakeTelegram();
    const hub = new PlatformHub([tg.platform, qq]);
    const started = Date.now();
    const { selfIds } = await hub.start(makeHost());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(selfIds).toEqual({ telegram: "999", qq: "pending" });
    const signal = new AbortController().signal;
    expect(
      await hub.act("telegram:-100", { kind: "send", text: "hi", replyTo: null }, signal),
    ).toEqual({ kind: "posted", messageId: "tg-1" });
    await expect(
      hub.act("qq:group:300", { kind: "send", text: "x", replyTo: null }, signal),
    ).rejects.toMatchObject({ failure: { reason: "unavailable" } });
    await hub.stop();
  });

  it("rotation keeps platform capabilities: a QQ group under rotation gets unsend and sticker, never edit", () => {
    const qq = new QQPlatform(
      { name: "qq", wsUrl: "ws://127.0.0.1:3001", token: null, selfId: null },
      { gateway: fakeGateway(() => ({})), operatorId: null, ignoredSenders: new Set(), tts: null },
    );
    const hub = new PlatformHub([makeFakeTelegram().platform, qq]);
    const mind = rotationOf({ candidate: "no-diary", seed: "s", unit: null }, [], (scope) =>
      hub.capabilitiesFor(scope),
    );
    const ownLine = {
      at: T0,
      messageId: "50",
      sender: null,
      text: "刚发的",
      contentType: "text",
      replyToMessageId: null,
    };
    const qqGroup = { ...emptyChat("qq:group:300", "group", true), timeline: [ownLine] };
    const tgGroup = { ...emptyChat("telegram:-100", "group", true), timeline: [ownLine] };
    const state = { ...emptyState, chats: { "qq:group:300": qqGroup, "telegram:-100": tgGroup } };
    for (const arm of [mind.production, mind.candidate]) {
      const qqReq = speechRequest(state, qqGroup, T0 + 5_000, null, arm);
      expect(qqReq.affordances).toContain("unsend");
      expect(qqReq.affordances).not.toContain("edit");
      expect(qqReq.affordances).toContain("sticker");
      const tgReq = speechRequest(state, tgGroup, T0 + 5_000, null, arm);
      expect(tgReq.affordances).toContain("edit");
      expect(tgReq.affordances).not.toContain("unsend");
    }
    // 两套机制共用平台能力那一项（同一个对象）：轮换只把候选真正改过的机制算作改动。
    const capsIn = (arm: typeof mind.production) =>
      arm.find((m) => m.name === "platform-capabilities");
    expect(capsIn(mind.candidate)).toBeDefined();
    expect(capsIn(mind.candidate)).toBe(capsIn(mind.production));
  });
});

describe("operator across platforms", () => {
  const cfgEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), "alice-ops-cfg-"));
    const cfgPath = join(dir, "config.toml");
    writeFileSync(cfgPath, "[telegram]\n[speech]\n");
    return {
      ALICE_CONFIG_PATH: cfgPath,
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      TELEGRAM_PHONE: "+10000000000",
      QQ_ONEBOT_WS_URL: "ws://127.0.0.1:3001",
      LLM_API_KEY: "sk-test",
      ALICE_OPERATOR_ID: "42",
      ALICE_TTS: "off",
      ...extra,
    };
  };
  const operatorFor = (scopes: ReadonlySet<string>) => {
    const dir = mkdtempSync(join(tmpdir(), "alice-ops-"));
    return new Operator(
      {
        now: () => T0,
        send: async () => {},
        stop: () => {},
        state: () => emptyState,
        log: () => {},
        selftest: async () => "",
      },
      {
        operatorId: "42",
        operatorScopes: scopes,
        controlPath: join(dir, "ops-control.json"),
        spend: new SpendMeter(join(dir, "spend"), () => T0),
        capUsd: 3,
      },
    );
  };
  const opsCommand = (scope: string, senderId: string): MessageReceived => ({
    type: "message.received",
    at: T0,
    scope,
    chatType: "private",
    messageId: "1",
    senderId,
    senderName: "x",
    text: "/ops status",
    contentType: "text",
    replyToMessageId: null,
    directed: true,
  });

  it("with telegram,qq, a QQ user whose number equals ALICE_OPERATOR_ID is not the operator", () => {
    const cfg = loadRuntimeConfig(cfgEnv({ ALICE_PLATFORM: "telegram,qq" }));
    expect(cfg.ops.qqOperatorId).toBeNull();
    const scopes = operatorScopes(cfg);
    expect([...scopes]).toEqual(["telegram:42"]);
    const operator = operatorFor(scopes);
    expect(operator.intercept(opsCommand("qq:private:42", "42"))).toBe(false);
    expect(operator.intercept(opsCommand("telegram:42", "42"))).toBe(true);
  });

  it("QQ_OPERATOR_ID names the QQ operator; with QQ alone ALICE_OPERATOR_ID is the QQ number", () => {
    const both = loadRuntimeConfig(cfgEnv({ ALICE_PLATFORM: "telegram,qq", QQ_OPERATOR_ID: "77" }));
    const scopes = operatorScopes(both);
    expect([...scopes].sort()).toEqual(["qq:private:77", "telegram:42"]);
    expect(operatorFor(scopes).intercept(opsCommand("qq:private:77", "77"))).toBe(true);
    const qqOnly = loadRuntimeConfig(cfgEnv({ ALICE_PLATFORM: "qq" }));
    expect([...operatorScopes(qqOnly)]).toEqual(["qq:private:42"]);
    expect(() => loadRuntimeConfig(cfgEnv({ QQ_OPERATOR_ID: "alice" }))).toThrow("QQ_OPERATOR_ID");
  });
});
