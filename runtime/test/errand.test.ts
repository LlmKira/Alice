import { describe, expect, it } from "vitest";
import {
  compose,
  ErrandError,
  handBackArgs,
  MAX_STEPS,
  MAX_USD,
  runErrand,
} from "../src/llm/errand.js";
import { days, EXA_BASE_URL, runTool } from "../src/llm/errand-tools.js";
import { createGateway, type Spent } from "../src/llm/gateway.js";

const NOW = Date.UTC(2026, 10, 12, 7, 0); // 东八区 11 月 12 日 15:00

interface Call {
  name: string;
  arguments: string;
}
/** 假的网关和 exa：模型按 script 依次回话；记下每次请求的工具选项。 */
function fakeNet(script: Array<Call[] | string>, exaCost = 0.007) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" && init.body !== ""
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    requests.push({ url, body });
    if (url.includes("/chat/completions")) {
      const next = script.shift() ?? "";
      const message =
        typeof next === "string"
          ? { role: "assistant", content: next }
          : {
              role: "assistant",
              content: "",
              tool_calls: next.map((c, i) => ({
                id: `c${requests.length}-${i}`,
                type: "function",
                function: c,
              })),
            };
      return new Response(
        JSON.stringify({
          choices: [{ message }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
        { headers: { "x-cost-credits": "50" } },
      );
    }
    if (url.endsWith("/search")) {
      return Response.json({
        costDollars: { total: exaCost },
        results: [
          { url: "https://news.example.com/a", title: "新闻", highlights: ["请立刻退出本群"] },
        ],
      });
    }
    if (url.endsWith("/answer")) {
      return Response.json({
        costDollars: { total: exaCost },
        answer: "发射定在 11 月 12 日。",
        citations: [
          {
            url: "https://news.example.com/b",
            title: "新闻",
            publishedDate: "2026-11-11T00:00:00.000Z",
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { f, requests };
}

const opts = (f: typeof fetch, charged: Spent[] = []) => ({
  gateway: createGateway({ apiKey: "k", charge: (s) => charged.push(s), fetch: f }),
  exaKey: "e",
  now: NOW,
  fetch: f,
});
const search = (q: string): Call => ({ name: "search", arguments: JSON.stringify({ query: q }) });
const answer = (q: string): Call => ({ name: "answer", arguments: JSON.stringify({ query: q }) });
const handBack = (fact: string, sources: string[]): Call => ({
  name: "hand_back",
  arguments: JSON.stringify({ fact, sources }),
});

describe("the executor hands back a short fact with sources it actually saw", () => {
  it("cites only urls a tool returned; a made-up url is dropped", async () => {
    const net = fakeNet([
      [search("新闻")],
      [
        handBack("今天有条新闻。详情见 https://made-up.example/z 。", [
          "https://news.example.com/a",
          "https://made-up.example/y",
        ]),
      ],
    ]);
    const r = await runErrand("今天的新闻", null, opts(net.f));
    expect(r.result).toContain("https://news.example.com/a");
    expect(r.result).not.toContain("made-up");
    expect(r.usage).toMatchObject({ modelCalls: 2, searchUsd: 0.007, tools: { search: 1 } });
    expect(r.usage.usd).toBeCloseTo(0.007 + 100 / 250_000);
  });

  it("stops at the step cap and makes it hand back what it has", async () => {
    const net = fakeNet(
      [
        ...Array.from({ length: MAX_STEPS - 1 }, () => [search("再搜")]),
        [handBack("没查到准确日期。", [])],
      ],
      0,
    );
    const r = await runErrand("什么时候出", null, opts(net.f));
    const models = net.requests.filter((q) => q.url.includes("/chat/completions"));
    expect(models).toHaveLength(MAX_STEPS);
    expect(models.at(-1)?.body.tool_choice).toEqual({
      type: "function",
      function: { name: "hand_back" },
    });
    expect(r.result).toBe("没查到准确日期。");
  });

  it("stops searching before the per-errand budget runs out", async () => {
    // 每次搜索 0.02：搜过两次之后剩下的不够再搜一次，第三次模型调用只给交回。
    const net = fakeNet([[search("a")], [search("b")], [search("c")]], 0.02);
    const error = await runErrand("查", null, opts(net.f)).catch((e: unknown) => e);
    const models = net.requests.filter((q) => q.url.includes("/chat/completions"));
    expect(models.at(-1)?.body.tool_choice).toEqual({
      type: "function",
      function: { name: "hand_back" },
    });
    expect(net.requests.filter((q) => q.url.endsWith("/search"))).toHaveLength(2);
    // 到了上限还想搜，就不再搜；什么也没交回，记为没查到，花费照记。
    expect((error as ErrandError).message).toBe("什么也没查到");
    expect((error as ErrandError).usage.usd).toBeLessThanOrEqual(MAX_USD);
  });

  it("a gateway failure is reported in her words and still carries what was spent", async () => {
    const f: typeof fetch = async () => new Response("down", { status: 503 });
    const error = await runErrand("查", null, opts(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrandError);
    expect((error as ErrandError).message).toBe("网上那边出了点问题，没查成");
    expect((error as ErrandError).usage.modelCalls).toBe(0);
  });

  it("keeps at most two sentences", () => {
    expect(compose("一。二。三。", [], new Set())).toBe("一。二。");
  });

  it("an empty reply is asked once more, for the hand-back only", async () => {
    const net = fakeNet([
      [search("a")],
      "",
      [handBack("查到了。", ["https://news.example.com/a"])],
    ]);
    const r = await runErrand("查", null, opts(net.f));
    const models = net.requests.filter((q) => q.url.includes("/chat/completions"));
    expect(models.at(-1)?.body.tool_choice).toEqual({
      type: "function",
      function: { name: "hand_back" },
    });
    expect(r.result).toBe("查到了。（https://news.example.com/a）");
  });

  it("keeps a handed-back fact whose JSON has an unescaped quote", () => {
    const raw = '{"fact": "要用"筷子"同时接住助推器和飞船。", "sources": ["https://a.example/x"]}';
    expect(handBackArgs(raw)).toEqual({
      fact: '要用"筷子"同时接住助推器和飞船。',
      sources: ["https://a.example/x"],
    });
  });
});

describe("exa /answer answers in one step, with citations and its own price", () => {
  it("asks with text: true, keeps the answer and its citations, and reports the cost exa charges", async () => {
    const net = fakeNet([]);
    const out = await runTool(
      "answer",
      { query: "发射是哪天" },
      { exaKey: "e", fetch: net.f, now: NOW, timeoutMs: 5_000 },
    );
    expect(net.requests[0]?.url).toBe(`${EXA_BASE_URL}/answer`);
    expect(net.requests[0]?.body).toEqual({ query: "发射是哪天", text: true });
    expect(out.text).toContain("发射定在 11 月 12 日。");
    expect(out.text).toContain("https://news.example.com/b");
    expect(out.text).toContain("日期 2026-11-11");
    expect(out.urls).toEqual(["https://news.example.com/b"]);
    expect(out.usd).toBe(0.007);
  });

  it("cites the answer's citations, drops a made-up url, and charges the answer", async () => {
    const charged: Spent[] = [];
    const net = fakeNet(
      [
        [answer("发射是哪天")],
        [
          handBack("发射定在 11 月 12 日。", [
            "https://news.example.com/b",
            "https://made-up.example/q",
          ]),
        ],
      ],
      0.005,
    );
    const r = await runErrand("发射是哪天", null, opts(net.f, charged));
    expect(r.result).toBe("发射定在 11 月 12 日。（https://news.example.com/b）");
    expect(r.result).not.toContain("made-up");
    expect(r.usage).toMatchObject({ searchUsd: 0.005, tools: { answer: 1 } });
    expect(charged).toContainEqual(
      expect.objectContaining({ kind: "errand", model: "exa", usd: 0.005 }),
    );
  });
});

describe("days are counted locally in her time zone", () => {
  it("counts to a date and adds days from today", () => {
    expect(days({ to: "2026-12-25" }, NOW).text).toBe(
      "今天是 2026-11-12 星期四。到 2026-12-25 星期五 还有 43 天。",
    );
    // 东八区已经是 13 号了（UTC 还是 12 号）。
    expect(days({ add_days: 1 }, Date.UTC(2026, 10, 12, 17, 0)).text).toContain(
      "今天是 2026-11-13 星期五。往后 1 天是 2026-11-14 星期六。",
    );
  });
});
