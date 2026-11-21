/**
 * 组合核（src/mind/compose.ts）的规则：一块只有一个提供者；缺块的部分不激活并列出缺什么；
 * 互相依赖的都不激活；拿掉一个提供者，读它的部分跟着不激活；uses 和 amends 都列出来。
 */
import { describe, expect, it } from "vitest";
import { CompositionError, compose, type Part } from "../src/mind/compose.js";

const base: Part = { name: "world", provides: ["chats"] };

describe("compose", () => {
  it("two providers of one key are an error at compose time", () => {
    const a: Part = { name: "a", provides: ["mood"] };
    const b: Part = { name: "b", provides: ["mood"] };
    expect(() => compose(base, [a, b])).toThrow(CompositionError);
    expect(() => compose(base, [{ name: "c", provides: ["chats"] }])).toThrow(/chats/);
  });

  it("the same name twice is an error (state is stored by name)", () => {
    expect(() => compose(base, [{ name: "a" }, { name: "a" }])).toThrow(CompositionError);
  });

  it("a part whose requirement has no provider is inactive and says what it misses", () => {
    const diary: Part = { name: "diary", requires: ["chats", "mood"] };
    const c = compose(base, [diary]);
    expect(c.active).toEqual([]);
    expect(c.inactive).toEqual([{ part: "diary", missing: ["mood"] }]);
  });

  it("activation does not depend on order, and keeps the given order", () => {
    const diary: Part = { name: "diary", requires: ["mood"] };
    const affect: Part = { name: "affect", provides: ["mood"] };
    expect(compose(base, [diary, affect]).active).toEqual([diary, affect]);
  });

  it("removing a provider deactivates its consumers, transitively", () => {
    const affect: Part = { name: "affect", provides: ["mood"] };
    const diary: Part = { name: "diary", requires: ["mood"], provides: ["diary"] };
    const topic: Part = { name: "topic", requires: ["diary"] };
    expect(compose(base, [affect, diary, topic]).inactive).toEqual([]);
    const without = compose(base, [diary, topic]);
    expect(without.active).toEqual([]);
    expect(without.inactive).toEqual([
      { part: "diary", missing: ["mood"] },
      { part: "topic", missing: ["diary"] },
    ]);
  });

  it("a dependency cycle leaves both parts inactive (§6.5)", () => {
    const a: Part = { name: "a", provides: ["x"], requires: ["y"] };
    const b: Part = { name: "b", provides: ["y"], requires: ["x"] };
    const c = compose(base, [a, b]);
    expect(c.active).toEqual([]);
    expect(c.inactive.map((i) => i.part)).toEqual(["a", "b"]);
  });

  it("an optional read without a provider stays active and is listed as a gap", () => {
    const life: Part = { name: "life", provides: ["life"], uses: ["mood"] };
    const c = compose(base, [life]);
    expect(c.active).toEqual([life]);
    expect(c.gaps).toEqual([{ part: "life", key: "mood" }]);
    expect(compose(base, [life, { name: "affect", provides: ["mood"] }]).gaps).toEqual([]);
  });

  it("a write to someone else's key is listed with its owner", () => {
    const fold: Part = { name: "world", provides: ["chats"], amends: ["promises"] };
    const memory: Part = { name: "memory", provides: ["promises"] };
    expect(compose(fold, [memory]).shared).toEqual([
      { part: "world", key: "promises", owner: "memory" },
    ]);
    expect(compose(fold, []).shared).toEqual([{ part: "world", key: "promises", owner: null }]);
  });

  it("an inactive part provides nothing", () => {
    const affect: Part = { name: "affect", provides: ["mood"], requires: ["noise"] };
    const c = compose(base, [affect]);
    expect(c.providers.has("mood")).toBe(false);
    expect(c.providers.get("chats")).toBe("world");
  });
});
