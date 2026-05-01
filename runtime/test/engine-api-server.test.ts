/**
 * Engine API route integration tests.
 *
 * Verifies strict capability mode observes dynamic registry changes without restart.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import * as dbQueries from "../src/db/queries.js";
import { listSocialEventsForRelation } from "../src/db/social-case.js";
import { routeRequest } from "../src/engine-api/server.js";
import { WorldModel } from "../src/graph/world-model.js";
import { socialCaseMod } from "../src/mods/social-case.mod.js";
import type { TransportAdapter } from "../src/platform/transport.js";
import type { Registry } from "../src/skills/registry.js";
import { TelegramActionError } from "../src/telegram/errors.js";

let dynamicRegistry: Registry = {};

vi.mock("../src/skills/registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skills/registry.js")>();
  return {
    ...original,
    loadRegistry: vi.fn(() => dynamicRegistry),
    mergeRegistryWithBuiltIns: vi.fn((registry: Registry) => ({
      "alice-system": {
        name: "alice-system",
        version: "1.0.0",
        hash: "builtin-system",
        storePath: "/tmp/skills/system-bin",
        commandPath: "/tmp/skills/system-bin/irc",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["irc", "self", "engine", "ctl", "ask"],
        categories: ["app"],
        capabilities: [
          "chat.read",
          "graph.read",
          "transport.send",
          "transport.read",
          "transport.react",
          "telegram.send",
          "telegram.read",
          "telegram.react",
          "telegram.join",
          "telegram.leave",
          "telegram.forward",
          "query",
        ],
        backend: "shell",
      },
      ...registry,
    })),
  };
});

function makeReq(skill?: string): IncomingMessage {
  return {
    method: "GET",
    url: "/config/timezoneOffset",
    headers: skill ? { "x-alice-skill": skill } : {},
  } as IncomingMessage;
}

function makeChatReq(chatId: string, skill?: string, limit?: number): IncomingMessage {
  return {
    method: "GET",
    url: `/chat/${chatId}/tail${limit ? `?limit=${limit}` : ""}`,
    headers: skill ? { "x-alice-skill": skill } : {},
  } as IncomingMessage;
}

function makeTelegramReq(action: string, skill?: string): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: `/telegram/${action}`,
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeTransportReq(action: string, skill?: string): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: `/transport/${action}`,
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeResolveTargetReq(): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: "/resolve/target",
    headers: {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeDispatchReq(skill?: string, _body?: unknown): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: "/dispatch/DECLARE_ACTION",
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeQueryReq(skill?: string, body?: unknown): IncomingMessage {
  void body; // body 通过 runBody() 单独注入，此处仅保持接口对称
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: "/query/contact_profile",
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeCmdReq(name: string, skill?: string): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: `/cmd/${name}`,
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

async function runBody(req: IncomingMessage, body?: unknown): Promise<void> {
  const listeners = (req as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("vitest.dispatchListeners")
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback
  ] as Record<string, Array<(...args: any[]) => void>> | undefined;
  if (!listeners) return;
  if (body !== undefined) {
    for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
  }
  for (const cb of listeners.end ?? []) cb();
}

function makeRes() {
  let statusCode = 200;
  let body = "";
  const res: {
    headersSent: boolean;
    writeHead(code: number): unknown;
    end(chunk?: string): unknown;
  } = {
    headersSent: false,
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      this.headersSent = true;
      return this;
    },
  };

  return {
    res: res as unknown as ServerResponse,
    snapshot: () => ({
      statusCode,
      body: body ? JSON.parse(body) : null,
    }),
  };
}

describe("Engine API route", () => {
  it("strict mode picks up newly installed skills without restart", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");

    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
    };

    const deniedRes = makeRes();
    await routeRequest(makeReq("calendar"), deniedRes.res, deps);
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "config.read"' },
    });

    dynamicRegistry = {
      calendar: {
        name: "calendar",
        version: "1.0.0",
        hash: "hash-calendar",
        storePath: "/tmp/skills/store/hash-calendar",
        commandPath: "/tmp/skills/store/hash-calendar/calendar",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["use_calendar_app"],
        categories: ["app"],
        capabilities: ["config.read"],
        backend: "shell",
      },
    };

    const allowedRes = makeRes();
    await routeRequest(makeReq("calendar"), allowedRes.res, deps);
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { value: 8 },
    });
  });

  it("query syscall is capability-gated and forwards to dispatcher query bridge", async () => {
    dynamicRegistry = {
      observer: {
        name: "observer",
        version: "1.0.0",
        hash: "hash-observer",
        storePath: "/tmp/skills/store/hash-observer",
        commandPath: "/tmp/skills/store/hash-observer/observer",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["do_observer_thing"],
        categories: ["app"],
        capabilities: ["query"],
        backend: "shell",
      },
    };

    const G = new WorldModel();
    G.addAgent("self");
    const query = vi.fn((_name: string, args: Record<string, unknown>) => ({ seen: args.chatId }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      query,
    };

    const deniedRes = makeRes();
    const deniedReq = makeQueryReq("calendar", { chatId: 7 });
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { chatId: 7 });
    await deniedPromise;
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "query"' },
    });

    const allowedRes = makeRes();
    const allowedReq = makeQueryReq("observer", { chatId: 7 });
    const allowedPromise = routeRequest(allowedReq, allowedRes.res, deps);
    await runBody(allowedReq, { chatId: 7 });
    await allowedPromise;

    expect(query).toHaveBeenCalledWith("contact_profile", { chatId: 7 });
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true, result: { seen: 7 } },
    });
  });

  it("dispatch syscall is capability-gated and forwards to dispatcher bridge", async () => {
    dynamicRegistry = {
      operator: {
        name: "operator",
        version: "1.0.0",
        hash: "hash-operator",
        storePath: "/tmp/skills/store/hash-operator",
        commandPath: "/tmp/skills/store/hash-operator/operator",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["do_operator_thing"],
        categories: ["app"],
        capabilities: ["dispatch"],
        backend: "shell",
      },
    };

    const G = new WorldModel();
    G.addAgent("self");
    const dispatchInstruction = vi.fn((_instruction: string, args: Record<string, unknown>) => ({
      accepted: args.target,
    }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      dispatchInstruction,
    };

    const deniedRes = makeRes();
    const deniedReq = makeDispatchReq("calendar", { target: "self" });
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { target: "self" });
    await deniedPromise;
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "dispatch"' },
    });

    const allowedRes = makeRes();
    const allowedReq = makeDispatchReq("operator", { target: "self" });
    const allowedPromise = routeRequest(allowedReq, allowedRes.res, deps);
    await runBody(allowedReq, { target: "self" });
    await allowedPromise;

    expect(dispatchInstruction).toHaveBeenCalledWith("DECLARE_ACTION", { target: "self" });
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true, result: { accepted: "self" } },
    });
  });

  it("cmd syscall routes instruction names to dispatch instead of query", async () => {
    dynamicRegistry = {};
    const G = new WorldModel();
    G.addAgent("self");
    const query = vi.fn();
    const dispatchInstruction = vi.fn((_name: string, args: Record<string, unknown>) => ({
      accepted: args.target,
    }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      query,
      dispatchInstruction,
      resolveCommandKind: (name: string) => (name === "feel" ? "instruction" : undefined),
    } as const;

    const res = makeRes();
    const req = makeCmdReq("feel");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { target: "self" });
    await promise;

    expect(query).not.toHaveBeenCalled();
    expect(dispatchInstruction).toHaveBeenCalledWith("feel", { target: "self" });
    expect(res.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true, result: { accepted: "self" } },
    });
  });

  it("cmd syscall routes query names to query", async () => {
    dynamicRegistry = {};
    const G = new WorldModel();
    G.addAgent("self");
    const query = vi.fn((_name: string, args: Record<string, unknown>) => ({ level: args.level }));
    const dispatchInstruction = vi.fn();
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      query,
      dispatchInstruction,
      resolveCommandKind: (name: string) => (name === "pressure" ? "query" : undefined),
    } as const;

    const res = makeRes();
    const req = makeCmdReq("pressure");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { level: "high" });
    await promise;

    expect(query).toHaveBeenCalledWith("pressure", { level: "high" });
    expect(dispatchInstruction).not.toHaveBeenCalled();
    expect(res.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true, result: { level: "high" } },
    });
  });

  it("cmd syscall preserves social case handles through dispatcher context writeback", async () => {
    initDb(":memory:");
    try {
      dynamicRegistry = {};
      const G = new WorldModel();
      G.addAgent("self");
      const dispatcher = createAliceDispatcher({ graph: G, mods: [socialCaseMod] });
      dispatcher.startTick(42, 1_000_000);
      const deps = {
        config: {
          timezoneOffset: 8,
          exaApiKey: "",
          musicApiBaseUrl: "",
          youtubeApiKey: "",
        },
        G,
        strictCapabilities: false,
        registry: {},
        dispatchInstruction: (name: string, args: Record<string, unknown>) =>
          dispatcher.dispatch(name, args),
        query: (name: string, args: Record<string, unknown>) => dispatcher.query(name, args),
        resolveCommandKind: (name: string) => {
          if (dispatcher.getQueryDef(name)) return "query";
          if (dispatcher.getInstructionDef(name)) return "instruction";
          return undefined;
        },
      } as const;

      const firstRes = makeRes();
      const firstReq = makeCmdReq("social_case_note");
      const firstPromise = routeRequest(firstReq, firstRes.res, deps);
      await runBody(firstReq, {
        kind: "insult",
        other: "contact:A",
        venue: "技术群",
        visibility: "public",
        text: "Alice 你真的很蠢，别装懂了.",
        __contextVars: {
          CURRENT_SOCIAL_CASE_ID: "case:visible-public-insult",
          CURRENT_SOCIAL_CASE_HANDLE: "firm-repair",
        },
      });
      await firstPromise;

      expect(firstRes.snapshot()).toMatchObject({
        statusCode: 200,
        body: { ok: true, result: { success: true, open: true } },
      });

      const secondRes = makeRes();
      const secondReq = makeCmdReq("social_case_note");
      const secondPromise = routeRequest(secondReq, secondRes.res, deps);
      await runBody(secondReq, {
        kind: "boundary_violation",
        other: "contact:A",
        venue: "技术群",
        visibility: "public",
        text: "Alice 你还是很蠢。",
        case: "firm-repair",
        __contextVars: {
          SOCIAL_CASE_0_HANDLE: "firm-repair",
          SOCIAL_CASE_0_ID: "case:visible-public-insult",
        },
      });
      await secondPromise;

      expect(secondRes.snapshot()).toMatchObject({
        statusCode: 200,
        body: { ok: true, result: { success: true, open: true } },
      });
      expect(
        listSocialEventsForRelation(["alice", "contact:A"]).map((event) => event.caseId),
      ).toEqual(["case:visible-public-insult", "case:visible-public-insult"]);
    } finally {
      closeDb();
    }
  });

  it("cmd syscall returns typed 404 for unknown names", async () => {
    dynamicRegistry = {};
    const G = new WorldModel();
    G.addAgent("self");
    const query = vi.fn();
    const dispatchInstruction = vi.fn();
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      query,
      dispatchInstruction,
      resolveCommandKind: () => undefined,
    } as const;

    const res = makeRes();
    const req = makeCmdReq("missing");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, {});
    await promise;

    expect(query).not.toHaveBeenCalled();
    expect(dispatchInstruction).not.toHaveBeenCalled();
    expect(res.snapshot()).toEqual({
      statusCode: 404,
      body: { code: "unknown_cmd", error: "unknown command: missing" },
    });
  });

  it("telegram system chat syscalls are gated and forwarded", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async ({ chatId, text }: { chatId: number; text: string }) => ({
      msgId: chatId + text.length,
    }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      telegramSend,
    };

    const deniedRes = makeRes();
    const deniedReq = makeTelegramReq("send", "calendar");
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { chatId: 1, text: "hello" });
    await deniedPromise;
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "telegram.send"' },
    });

    const allowedRes = makeRes();
    const allowedReq = makeTelegramReq("send", "alice-system");
    const allowedPromise = routeRequest(allowedReq, allowedRes.res, deps);
    await runBody(allowedReq, { chatId: 7, text: "hello" });
    await allowedPromise;

    expect(telegramSend).toHaveBeenCalledWith({ chatId: 7, text: "hello", replyTo: undefined });
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { msgId: 12 },
    });
  });

  it("transport send dispatches through platform adapter", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");
    const send = vi.fn(async () => ({
      platform: "telegram",
      target: "channel:telegram:7",
      messageId: "message:telegram:7:21",
      nativeMessageId: 21,
    }));
    const telegramAdapter: TransportAdapter = {
      platform: "telegram",
      send,
    };
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      transportAdapters: { telegram: telegramAdapter },
    };

    const res = makeRes();
    const req = makeTransportReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, {
      target: "channel:telegram:7",
      text: "hello",
      replyTo: "message:telegram:7:9",
    });
    await promise;

    expect(send).toHaveBeenCalledWith({
      target: {
        kind: "channel",
        platform: "telegram",
        nativeId: "7",
        stableId: "channel:telegram:7",
        legacy: false,
      },
      text: "hello",
      replyTo: {
        platform: "telegram",
        chatNativeId: "7",
        messageNativeId: "9",
        stableId: "message:telegram:7:9",
      },
    });
    expect(res.snapshot()).toEqual({
      statusCode: 200,
      body: {
        platform: "telegram",
        target: "channel:telegram:7",
        messageId: "message:telegram:7:21",
        nativeMessageId: 21,
      },
    });
  });

  it("transport send can synthesize Telegram adapter from existing callbacks", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(
      async ({ chatId, text, replyTo }: { chatId: number; text: string; replyTo?: number }) => ({
        msgId: chatId + text.length + (replyTo ?? 0),
      }),
    );
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSend,
    };

    const res = makeRes();
    const req = makeTransportReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, {
      target: "channel:telegram:7",
      text: "hello",
      replyTo: "message:telegram:7:9",
    });
    await promise;

    expect(telegramSend).toHaveBeenCalledWith({ chatId: 7, text: "hello", replyTo: 9 });
    expect(res.snapshot()).toEqual({
      statusCode: 200,
      body: {
        platform: "telegram",
        target: "channel:telegram:7",
        messageId: "message:telegram:7:21",
        nativeMessageId: 21,
      },
    });
  });

  it("transport send normalizes legacy Telegram channel refs", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async () => ({ msgId: 12 }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSend,
    };

    const res = makeRes();
    const req = makeTransportReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { target: "channel:7", text: "legacy" });
    await promise;

    expect(telegramSend).toHaveBeenCalledWith({ chatId: 7, text: "legacy", replyTo: undefined });
    expect(res.snapshot()).toEqual({
      statusCode: 200,
      body: {
        platform: "telegram",
        target: "channel:telegram:7",
        messageId: "message:telegram:7:12",
        nativeMessageId: 12,
      },
    });
  });

  it("transport send returns typed 400 for invalid target refs", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async () => ({ msgId: 1 }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSend,
    };

    const res = makeRes();
    const req = makeTransportReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { target: "telegram:7", text: "hello" });
    await promise;

    expect(telegramSend).not.toHaveBeenCalled();
    expect(res.snapshot()).toEqual({
      statusCode: 400,
      body: { code: "invalid_target_ref", error: "invalid transport target ref" },
    });
  });

  it("transport refs reject bridge protocol names as platforms", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramReact = vi.fn(async () => ({ ok: true as const }));
    const send = vi.fn(async () => ({
      platform: "satori",
      target: "channel:satori:7",
      messageId: "message:satori:7:9",
      nativeMessageId: 9,
    }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramReact,
      transportAdapters: {
        satori: { platform: "satori", send },
      },
    };

    const sendRes = makeRes();
    const sendReq = makeTransportReq("send");
    const sendPromise = routeRequest(sendReq, sendRes.res, deps);
    await runBody(sendReq, { target: "channel:satori:7", text: "hello" });
    await sendPromise;

    const reactRes = makeRes();
    const reactReq = makeTransportReq("react");
    const reactPromise = routeRequest(reactReq, reactRes.res, deps);
    await runBody(reactReq, {
      target: "channel:telegram:7",
      message: "message:satori:7:9",
      emoji: "ok",
    });
    await reactPromise;

    expect(send).not.toHaveBeenCalled();
    expect(sendRes.snapshot()).toEqual({
      statusCode: 400,
      body: { code: "invalid_target_ref", error: "invalid transport target ref" },
    });
    expect(reactRes.snapshot()).toEqual({
      statusCode: 400,
      body: { code: "invalid_message_ref", error: "invalid transport message ref" },
    });
  });

  it("transport send returns typed 501 for unsupported non-Telegram targets", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async () => ({ msgId: 1 }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSend,
    };

    const res = makeRes();
    const req = makeTransportReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { target: "channel:discord:7", text: "hello" });
    await promise;

    expect(telegramSend).not.toHaveBeenCalled();
    expect(res.snapshot()).toEqual({
      statusCode: 501,
      body: {
        code: "unsupported_capability",
        error: "discord transport send is not supported",
        platform: "discord",
        capability: "send",
      },
    });
  });

  it("transport send returns typed 502 for OneBot provider failures", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");
    const send = vi.fn(async () => {
      const err = new Error("OneBot send_group_msg failed") as Error & {
        action: string;
        retcode: number;
        responseText: string;
      };
      err.name = "OneBotActionError";
      err.action = "send_group_msg";
      err.retcode = 1404;
      err.responseText = '{"status":"failed"}';
      throw err;
    });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      transportAdapters: {
        qq: { platform: "qq", send },
      },
    };

    const res = makeRes();
    const req = makeTransportReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { target: "channel:qq:123", text: "hello" });
    await promise;

    expect(res.snapshot()).toEqual({
      statusCode: 502,
      body: {
        code: "onebot_action_failed",
        error: "OneBot send_group_msg failed",
        action: "send_group_msg",
        retcode: 1404,
        responseText: '{"status":"failed"}',
      },
    });
  });

  it("transport send is capability-gated through neutral transport capability", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async () => ({ msgId: 1 }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      telegramSend,
    };

    const deniedRes = makeRes();
    const deniedReq = makeTransportReq("send", "calendar");
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { target: "channel:telegram:7", text: "hello" });
    await deniedPromise;

    expect(telegramSend).not.toHaveBeenCalled();
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "transport.send"' },
    });
  });

  it("transport read and react delegate through synthesized Telegram adapter", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramMarkRead = vi.fn(async () => ({ ok: true as const }));
    const telegramReact = vi.fn(async () => ({ ok: true as const }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramMarkRead,
      telegramReact,
    };

    const readRes = makeRes();
    const readReq = makeTransportReq("read");
    const readPromise = routeRequest(readReq, readRes.res, deps);
    await runBody(readReq, { target: "contact:telegram:7" });
    await readPromise;

    const reactRes = makeRes();
    const reactReq = makeTransportReq("react");
    const reactPromise = routeRequest(reactReq, reactRes.res, deps);
    await runBody(reactReq, {
      target: "channel:telegram:7",
      message: "message:telegram:7:9",
      emoji: "👍",
    });
    await reactPromise;

    expect(telegramMarkRead).toHaveBeenCalledWith(7);
    expect(readRes.snapshot()).toEqual({
      statusCode: 200,
      body: { platform: "telegram", target: "contact:telegram:7", ok: true },
    });
    expect(telegramReact).toHaveBeenCalledWith({ chatId: 7, msgId: 9, emoji: "👍" });
    expect(reactRes.snapshot()).toEqual({
      statusCode: 200,
      body: {
        platform: "telegram",
        target: "channel:telegram:7",
        message: "message:telegram:7:9",
        ok: true,
      },
    });
  });

  it("resolve target returns stable refs and normalizes legacy graph ids", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel("channel:telegram:42", { display_name: "stable-room" });
    G.addChannel("channel:7", { display_name: "legacy-room" });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
    };

    const stableRes = makeRes();
    const stableReq = makeResolveTargetReq();
    const stablePromise = routeRequest(stableReq, stableRes.res, deps);
    await runBody(stableReq, { target: "channel:telegram:42" });
    await stablePromise;

    const legacyRes = makeRes();
    const legacyReq = makeResolveTargetReq();
    const legacyPromise = routeRequest(legacyReq, legacyRes.res, deps);
    await runBody(legacyReq, { target: "legacy-room" });
    await legacyPromise;

    expect(stableRes.snapshot()).toEqual({
      statusCode: 200,
      body: {
        ok: true,
        result: {
          target: "channel:telegram:42",
          platform: "telegram",
          kind: "channel",
          nativeId: "42",
          legacy: false,
        },
      },
    });
    expect(legacyRes.snapshot()).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        result: {
          target: "channel:telegram:7",
          platform: "telegram",
          kind: "channel",
          nodeId: "channel:7",
        },
      },
    });
  });

  it("resolve target returns typed ambiguity with platform-qualified candidates", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel("channel:telegram:42", { display_name: "guild" });
    G.addChannel("channel:discord:abc", { display_name: "guild" });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
    };

    const ambiguousRes = makeRes();
    const ambiguousReq = makeResolveTargetReq();
    const ambiguousPromise = routeRequest(ambiguousReq, ambiguousRes.res, deps);
    await runBody(ambiguousReq, { target: "guild" });
    await ambiguousPromise;

    const qualifiedRes = makeRes();
    const qualifiedReq = makeResolveTargetReq();
    const qualifiedPromise = routeRequest(qualifiedReq, qualifiedRes.res, deps);
    await runBody(qualifiedReq, { target: "discord/guild" });
    await qualifiedPromise;

    expect(ambiguousRes.snapshot()).toEqual({
      statusCode: 409,
      body: {
        ok: false,
        code: "ambiguous_target",
        error: 'ambiguous target: "guild"',
        candidates: [
          {
            target: "channel:telegram:42",
            nodeId: "channel:telegram:42",
            label: "guild",
            platform: "telegram",
            kind: "channel",
          },
          {
            target: "channel:discord:abc",
            nodeId: "channel:discord:abc",
            label: "guild",
            platform: "discord",
            kind: "channel",
          },
        ],
      },
    });
    expect(qualifiedRes.snapshot()).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        result: {
          target: "channel:discord:abc",
          platform: "discord",
          kind: "channel",
        },
      },
    });
  });

  it("resolve target rejects bridge protocol names as platforms", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel("channel:qq:room", { display_name: "guild" });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
    };

    const stableRes = makeRes();
    const stableReq = makeResolveTargetReq();
    const stablePromise = routeRequest(stableReq, stableRes.res, deps);
    await runBody(stableReq, { target: "channel:satori:room" });
    await stablePromise;

    const qualifiedRes = makeRes();
    const qualifiedReq = makeResolveTargetReq();
    const qualifiedPromise = routeRequest(qualifiedReq, qualifiedRes.res, deps);
    await runBody(qualifiedReq, { target: "satori/guild" });
    await qualifiedPromise;

    expect(stableRes.snapshot()).toEqual({
      statusCode: 400,
      body: {
        ok: false,
        code: "invalid_platform_ref",
        error: "satori is a bridge protocol, not an IM platform",
        platform: "satori",
      },
    });
    expect(qualifiedRes.snapshot()).toEqual({
      statusCode: 400,
      body: {
        ok: false,
        code: "invalid_platform_ref",
        error: "satori is a bridge protocol, not an IM platform",
        platform: "satori",
      },
    });
  });

  it("passes typed invalid Telegram reply refs as 400", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async () => {
      throw new TelegramActionError(
        "invalid_reply_ref",
        "invalid reply ref: use a visible #msgId from the current chat",
      );
    });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSend,
    };

    const res = makeRes();
    const req = makeTelegramReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, text: "reply ref failure", replyTo: 999 });
    await promise;

    expect(res.snapshot()).toEqual({
      statusCode: 400,
      body: {
        code: "invalid_reply_ref",
        error: "invalid reply ref: use a visible #msgId from the current chat",
      },
    });
  });

  it("passes typed invalid sticker keywords as 400", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSticker = vi.fn(async () => {
      throw new TelegramActionError(
        "invalid_sticker_keyword",
        'No sticker matches "tease". Valid: Emotions: happy. Actions: hug',
      );
    });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSticker,
    };

    const res = makeRes();
    const req = makeTelegramReq("sticker");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, sticker: "tease" });
    await promise;

    expect(res.snapshot()).toEqual({
      statusCode: 400,
      body: {
        code: "invalid_sticker_keyword",
        error: 'No sticker matches "tease". Valid: Emotions: happy. Actions: hug',
      },
    });
  });

  it("rejects unsupported Telegram reactions before calling Telegram", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramReact = vi.fn(async () => ({ ok: true as const }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramReact,
    };

    const res = makeRes();
    const req = makeTelegramReq("react");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, msgId: 9, emoji: "💤" });
    await promise;

    expect(telegramReact).not.toHaveBeenCalled();
    expect(res.snapshot().statusCode).toBe(400);
    expect(res.snapshot().body).toMatchObject({
      code: "invalid_reaction",
      error: "invalid reaction: use a Telegram-supported emoji",
    });
  });

  it("normalizes reaction variation selectors before Telegram", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramReact = vi.fn(async () => ({ ok: true as const }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramReact,
    };

    const res = makeRes();
    const req = makeTelegramReq("react");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, msgId: 9, emoji: "❤️" });
    await promise;

    expect(telegramReact).toHaveBeenCalledWith({ chatId: 7, msgId: 9, emoji: "❤" });
    expect(res.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true },
    });
  });

  it("passes typed provider-side invalid Telegram reactions as 400", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramReact = vi.fn(async () => {
      throw new TelegramActionError(
        "invalid_reaction",
        "invalid reaction: use a Telegram-supported emoji",
      );
    });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramReact,
    };

    const res = makeRes();
    const req = makeTelegramReq("react");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, msgId: 9, emoji: "👍" });
    await promise;

    expect(res.snapshot()).toEqual({
      statusCode: 400,
      body: {
        code: "invalid_reaction",
        error: "invalid reaction: use a Telegram-supported emoji",
      },
    });
  });

  it("passes typed provider-side voice privacy blocks as 400", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramVoice = vi.fn(async () => {
      throw new TelegramActionError(
        "voice_messages_forbidden",
        "telegram target forbids voice messages",
      );
    });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramVoice,
    };

    const res = makeRes();
    const req = makeTelegramReq("voice");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, text: "hello" });
    await promise;

    expect(res.snapshot()).toEqual({
      statusCode: 400,
      body: {
        code: "voice_messages_forbidden",
        error: "telegram target forbids voice messages",
      },
    });
  });

  it("passes typed deleted Telegram users as 400", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async () => {
      throw new TelegramActionError(
        "unreachable_telegram_user",
        "telegram target is deleted or deactivated",
      );
    });
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: false,
      registry: {},
      telegramSend,
    };

    const res = makeRes();
    const req = makeTelegramReq("send");
    const promise = routeRequest(req, res.res, deps);
    await runBody(req, { chatId: 7, text: "deleted-user-check" });
    await promise;

    expect(res.snapshot()).toEqual({
      statusCode: 400,
      body: {
        code: "unreachable_telegram_user",
        error: "telegram target is deleted or deactivated",
      },
    });
  });

  it("chat tail is capability-gated and reads recent messages", async () => {
    const tailSpy = vi.spyOn(dbQueries, "getRecentMessagesByChat").mockReturnValue([
      {
        platform: "telegram",
        msgId: 1,
        nativeChatId: "123",
        nativeMsgId: "1",
        stableMessageId: "message:telegram:123:1",
        senderName: "Alice",
        senderId: "self",
        text: "hello",
        isOutgoing: true,
        isDirected: false,
        mediaType: null,
        createdAt: new Date("2026-03-11T00:00:00.000Z"),
      },
    ]);

    const G = new WorldModel();
    G.addAgent("self");
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
    };

    const deniedRes = makeRes();
    await routeRequest(makeChatReq("123", "calendar", 5), deniedRes.res, deps);
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "chat.read"' },
    });

    const allowedRes = makeRes();
    await routeRequest(makeChatReq("123", "alice-system", 5), allowedRes.res, deps);
    expect(tailSpy).toHaveBeenCalledWith("channel:telegram:123", 5);
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: {
        messages: [
          {
            id: 1,
            messageId: "message:telegram:123:1",
            platform: "telegram",
            nativeChatId: "123",
            nativeMsgId: "1",
            sender: "Alice",
            senderId: "self",
            text: "hello",
            outgoing: true,
            directed: false,
            mediaType: null,
            timestamp: "2026-03-11T00:00:00.000Z",
          },
        ],
      },
    });
  });
});
