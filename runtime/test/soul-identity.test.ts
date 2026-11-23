/**
 * 她是谁、被问起时怎么答（研究员 2026-11-13）：被问是不是 AI 时承认还是否认，不写规定，让它自然涌现
 * （"不承认不否认，让其自然涌现，多做多错。本来就不应事事规定好"）。名字和平台按登录账号动态附加。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { said } from "../src/mechanisms/palette.js";
import { POOL, POOL_AUTHENTIC } from "../src/mechanisms/palette-pool.js";
import { applyAccountIdentity } from "../src/speech/prompt.js";

const soul = readFileSync(new URL("../SOUL.md", import.meta.url), "utf8");

describe("她是谁、被问起时怎么答", () => {
  it("人格活在平行世界，不硬编码具体名字、平台和 AI 特质", () => {
    expect(soul).not.toContain("AI");
    expect(soul).not.toContain("Alice");
    expect(soul).not.toContain("Telegram");
  });

  it("示例里没有替她回答'是不是 AI / 机器人'的", () => {
    const scripted = POOL.filter((e) => /机器人|AI/.test(e.scene + said(e.acts).join("")));
    expect(scripted).toEqual([]);
  });

  it("生产示例池 POOL_AUTHENTIC 不含高频粘性口癖（是吧 / 属于是 / 笑死）", () => {
    const polluted = POOL_AUTHENTIC.filter((e) => /是吧|属于是|笑死/.test(said(e.acts).join("")));
    expect(polluted).toEqual([]);
  });

  it("支持按登录账号名与启用平台动态附加身份信息", () => {
    const rendered = applyAccountIdentity(soul, {
      selfName: "小爱",
      platforms: ["telegram", "qq"],
    });
    expect(rendered).toMatch(/^你现在的名字是 小爱（别人顺口叫什么昵称都可以）。/);
    expect(rendered).toContain("只能通过 Telegram、QQ 和这边来往");
    expect(applyAccountIdentity(soul, {})).toBe(soul.trim());
  });
});
