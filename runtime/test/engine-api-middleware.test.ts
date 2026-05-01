/**
 * Engine API middleware 测试 — strict/lenient capability 验证。
 *
 * @see src/engine-api/middleware.ts
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { checkCapability, requiredCapability } from "../src/engine-api/middleware.js";
import type { Registry } from "../src/skills/registry.js";

/** 构造最小 IncomingMessage 模拟对象。 */
function fakeReq(method: string, url: string, skill?: string): IncomingMessage {
  return {
    method,
    url,
    headers: skill ? { "x-alice-skill": skill } : {},
  } as unknown as IncomingMessage;
}

/** 一个拥有 config.read 能力的 registry。 */
const REGISTRY: Registry = {
  calendar: {
    name: "calendar",
    version: "1.0.0",
    hash: "abc",
    storePath: "/tmp/skills/store/abc",
    commandPath: "/tmp/skills/store/abc/calendar",
    installedAt: "2026-01-01",
    actions: ["use_calendar"],
    categories: ["app"],
    capabilities: ["config.read"],
    backend: "shell",
  },
  chatter: {
    name: "chatter",
    version: "1.0.0",
    hash: "chat",
    storePath: "/tmp/skills/system-bin",
    commandPath: "/tmp/skills/system-bin/irc",
    installedAt: "2026-03-11",
    actions: ["irc"],
    categories: ["app"],
    capabilities: [
      "chat.read",
      "transport.send",
      "transport.read",
      "transport.react",
      "telegram.send",
      "telegram.read",
      "telegram.react",
      "telegram.join",
      "telegram.leave",
    ],
    backend: "shell",
  },
};

// ── requiredCapability ──────────────────────────────────────────────────

describe("requiredCapability", () => {
  it("config 非敏感 key → config.read", () => {
    expect(requiredCapability("GET", "/config/timezoneOffset")).toBe("config.read");
  });

  it("config 敏感 key → config.secrets", () => {
    expect(requiredCapability("GET", "/config/exaApiKey")).toBe("config.secrets");
  });

  it("graph GET → graph.read", () => {
    expect(requiredCapability("GET", "/graph/contact:123/name")).toBe("graph.read");
  });

  it("graph POST → graph.write", () => {
    expect(requiredCapability("POST", "/graph/contact:123/name")).toBe("graph.write");
  });

  it("engine selfcheck → engine.selfcheck", () => {
    expect(requiredCapability("POST", "/engine/selfcheck")).toBe("engine.selfcheck");
  });

  it("engine tick GET → config.read", () => {
    expect(requiredCapability("GET", "/engine/tick")).toBe("config.read");
  });

  it("llm synthesize → llm.synthesize", () => {
    expect(requiredCapability("POST", "/llm/synthesize")).toBe("llm.synthesize");
  });

  it("llm summarize → llm.summarize", () => {
    expect(requiredCapability("POST", "/llm/summarize")).toBe("llm.summarize");
  });

  it("未知路径 → null", () => {
    expect(requiredCapability("GET", "/unknown")).toBeNull();
  });

  it("telegram and transport send/read/react map to dedicated capabilities", () => {
    expect(requiredCapability("GET", "/chat/123/tail")).toBe("chat.read");
    expect(requiredCapability("POST", "/telegram/send")).toBe("telegram.send");
    expect(requiredCapability("POST", "/telegram/read")).toBe("telegram.read");
    expect(requiredCapability("POST", "/telegram/react")).toBe("telegram.react");
    expect(requiredCapability("POST", "/transport/send")).toBe("transport.send");
    expect(requiredCapability("POST", "/transport/read")).toBe("transport.read");
    expect(requiredCapability("POST", "/transport/react")).toBe("transport.react");
    expect(requiredCapability("POST", "/telegram/join")).toBe("telegram.join");
    expect(requiredCapability("POST", "/telegram/leave")).toBe("telegram.leave");
  });
});

// ── checkCapability: lenient mode ───────────────────────────────────────

describe("checkCapability — lenient", () => {
  it("无 header → 放行", () => {
    const req = fakeReq("GET", "/config/timezoneOffset");
    expect(checkCapability(req, REGISTRY, "lenient")).toEqual({ allowed: true });
  });

  it("无 registry → 放行", () => {
    const req = fakeReq("GET", "/config/timezoneOffset", "calendar");
    expect(checkCapability(req, undefined, "lenient")).toEqual({ allowed: true });
  });

  it("已知 skill + 有能力 → 放行", () => {
    const req = fakeReq("GET", "/config/timezoneOffset", "calendar");
    expect(checkCapability(req, REGISTRY, "lenient")).toEqual({ allowed: true });
  });

  it("已知 skill + 无能力 → 403", () => {
    const req = fakeReq("GET", "/config/exaApiKey", "calendar");
    const result = checkCapability(req, REGISTRY, "lenient");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.needed).toBe("config.secrets");
    }
  });

  it("未知 skill → lenient 放行", () => {
    const req = fakeReq("GET", "/config/timezoneOffset", "unknown-skill");
    expect(checkCapability(req, REGISTRY, "lenient")).toEqual({ allowed: true });
  });

  it("不需要 capability 的路径 → 放行", () => {
    const req = fakeReq("GET", "/unknown");
    expect(checkCapability(req, REGISTRY, "lenient")).toEqual({ allowed: true });
  });

  it("默认 mode 是 lenient", () => {
    const req = fakeReq("GET", "/config/timezoneOffset");
    // 不传 mode 参数
    expect(checkCapability(req, REGISTRY)).toEqual({ allowed: true });
  });

  it("telegram system client syscall checks dedicated capabilities", () => {
    const req = fakeReq("POST", "/telegram/send", "chatter");
    expect(checkCapability(req, REGISTRY, "lenient")).toEqual({ allowed: true });
  });

  it("transport system client syscall checks neutral capabilities", () => {
    const req = fakeReq("POST", "/transport/send", "chatter");
    expect(checkCapability(req, REGISTRY, "lenient")).toEqual({ allowed: true });
  });
});

// ── checkCapability: strict mode ────────────────────────────────────────

describe("checkCapability — strict", () => {
  it("无 header → 403", () => {
    const req = fakeReq("GET", "/config/timezoneOffset");
    const result = checkCapability(req, REGISTRY, "strict");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.skill).toBe("(no header)");
      expect(result.needed).toBe("config.read");
    }
  });

  it("未知 skill → 403", () => {
    const req = fakeReq("GET", "/config/timezoneOffset", "unknown-skill");
    const result = checkCapability(req, REGISTRY, "strict");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.skill).toBe("unknown-skill");
    }
  });

  it("已知 skill + 有能力 → 放行", () => {
    const req = fakeReq("GET", "/config/timezoneOffset", "calendar");
    expect(checkCapability(req, REGISTRY, "strict")).toEqual({ allowed: true });
  });

  it("已知 skill + 无能力 → 403", () => {
    const req = fakeReq("GET", "/config/exaApiKey", "calendar");
    const result = checkCapability(req, REGISTRY, "strict");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.needed).toBe("config.secrets");
    }
  });

  it("无 registry + strict → 403", () => {
    const req = fakeReq("GET", "/config/timezoneOffset", "calendar");
    const result = checkCapability(req, undefined, "strict");
    expect(result.allowed).toBe(false);
  });

  it("不需要 capability 的路径 → 放行（即使 strict）", () => {
    const req = fakeReq("GET", "/unknown");
    expect(checkCapability(req, REGISTRY, "strict")).toEqual({ allowed: true });
  });
});
