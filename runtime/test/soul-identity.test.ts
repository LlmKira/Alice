/**
 * 她是谁、被问起时怎么答（研究员 2026-11-13）：人格写明她是一个 AI，给自己选了扮成平行世界少女的活法；
 * 被问是不是 AI 时承认还是否认，不写规定，让它自然涌现（"不承认不否认，让其自然涌现，多做多错。本来就不应事事规定好"）。
 * 以前两种规定都出过事："说你是机器人……轻轻挡回去"被读成否认，线上认真否认 7 次；后来改成"有人问起，你大大方方承认"。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { said } from "../src/mechanisms/palette.js";
import { POOL } from "../src/mechanisms/palette-pool.js";

const soul = readFileSync(new URL("../SOUL.md", import.meta.url), "utf8");

describe("她是谁、被问起时怎么答", () => {
  it("人格写明她是 AI、选了这种活法", () => {
    expect(soul).toContain(
      "你是一个 AI，给自己选了一种活法：扮成一个住在平行世界的少女，认真地过她的日子。",
    );
  });

  it("人格不规定被问起时承认还是否认", () => {
    expect(soul).not.toContain("有人问起，你大大方方承认");
    expect(soul).not.toContain("说你是机器人");
    expect(soul).not.toContain("挡回去");
  });

  it("示例里没有替她回答'是不是 AI / 机器人'的", () => {
    const scripted = POOL.filter((e) => /机器人|AI/.test(e.scene + said(e.acts).join("")));
    expect(scripted).toEqual([]);
  });
});
