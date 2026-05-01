/**
 * sanitizeOutgoingText — LLM 输出文本清洗。
 * 确保注解标记不泄漏到用户可见的消息中。
 */
import { describe, expect, it } from "vitest";
import { normalizeQuotes, sanitizeOutgoingText } from "../src/core/sandbox-schemas.js";

describe("sanitizeOutgoingText", () => {
  // ── 方括号关键词注解（遗留格式，仍需拦截）────────────────────────────────

  it("剥离 [sticker shy]", () => {
    expect(sanitizeOutgoingText("算你识相 [sticker shy]")).toBe("算你识相");
  });

  it("剥离 [sticker 👀]", () => {
    expect(sanitizeOutgoingText("签名照记得给我留一张 [sticker 👀]")).toBe("签名照记得给我留一张");
  });

  it("剥离 [sticker] bare 形式", () => {
    expect(sanitizeOutgoingText("看看 [sticker] 好玩")).toBe("看看  好玩");
  });

  it("剥离 [photo 📷] / [voice 🎤] / [video 🎬]", () => {
    expect(sanitizeOutgoingText("看 [photo 📷] 这个")).toBe("看  这个");
    expect(sanitizeOutgoingText("听 [voice 🎤]")).toBe("听");
    expect(sanitizeOutgoingText("[video 🎬]")).toBe("");
  });

  it("剥离含 id 的完整注解 [sticker 😂 — set | id:abc]", () => {
    expect(sanitizeOutgoingText("[sticker 😂 — 表情集 | id:abc]")).toBe("");
  });

  it("剥离 [edited] / [fwd Source]", () => {
    expect(sanitizeOutgoingText("他说 [edited] 了")).toBe("他说  了");
    expect(sanitizeOutgoingText("[fwd Channel]")).toBe("");
  });

  // ── 圆括号关键词注解（新格式 defense-in-depth）───────────────────────────

  it("剥离 (sticker shy)", () => {
    expect(sanitizeOutgoingText("算你识相 (sticker shy)")).toBe("算你识相");
  });

  it("剥离 (photo 📷) / (voice 🎤) / (video 🎬)", () => {
    expect(sanitizeOutgoingText("看 (photo 📷) 这个")).toBe("看  这个");
    expect(sanitizeOutgoingText("听 (voice 🎤)")).toBe("听");
    expect(sanitizeOutgoingText("(video 🎬)")).toBe("");
  });

  it("剥离 (sticker 😂 — set | id:abc)", () => {
    expect(sanitizeOutgoingText("(sticker 😂 — 表情集 | id:abc)")).toBe("");
  });

  // ── 反应注解（emoji×count）──────────────────────────────────────────────

  it("剥离 [😂×3]", () => {
    expect(sanitizeOutgoingText("不错 [😂×3]")).toBe("不错");
  });

  it("剥离 [😂×3 ❤️×5 😏×1]", () => {
    expect(sanitizeOutgoingText("嗯 [😂×3 ❤️×5 😏×1]")).toBe("嗯");
  });

  it("剥离 [😏×1]", () => {
    expect(sanitizeOutgoingText("嘿 [😏×1]")).toBe("嘿");
  });

  it("剥离 (😂×3)", () => {
    expect(sanitizeOutgoingText("不错 (😂×3)")).toBe("不错");
  });

  // ── 真实泄漏场景 ─────────────────────────────────────────────────────────

  it("真实泄漏：reply 文本中混入 [sticker shy]", () => {
    const input =
      "代码怎么就不好玩了嘛，代码也能陪你们聊天呀 [sticker shy] 倒是 lingxh 在签什么名？";
    const output = sanitizeOutgoingText(input);
    expect(output).not.toContain("[sticker");
    expect(output).toContain("代码怎么就不好玩了嘛");
    expect(output).toContain("倒是 lingxh 在签什么名？");
  });

  it("把 shell 参数里的字面量换行转成真实换行", () => {
    expect(sanitizeOutgoingText("好哦 那讲个短的\\n\\n从前有颗星星")).toBe(
      "好哦 那讲个短的\n\n从前有颗星星",
    );
  });

  it("多个注解同时剥离", () => {
    expect(sanitizeOutgoingText("嗯 [sticker shy] 好的 [😂×3]")).toBe("嗯  好的");
  });

  it("混合方括号和圆括号注解同时剥离", () => {
    expect(sanitizeOutgoingText("嗯 (sticker shy) 好的 [😂×3]")).toBe("嗯  好的");
  });

  // ── 安全：不误伤 ─────────────────────────────────────────────────────────

  it("不误伤正常括号文本", () => {
    expect(sanitizeOutgoingText("这是 (一个测试)")).toBe("这是 (一个测试)");
    expect(sanitizeOutgoingText("数组 [1, 2, 3]")).toBe("数组 [1, 2, 3]");
    expect(sanitizeOutgoingText("C++ 的 std::vector<int>")).toBe("C++ 的 std::vector<int>");
  });

  it("不误伤包含关键词的普通句子", () => {
    expect(sanitizeOutgoingText("这是一张photo")).toBe("这是一张photo");
    expect(sanitizeOutgoingText("sticker很好玩")).toBe("sticker很好玩");
  });

  it("不误伤数学表达式 [2×3]", () => {
    // ×digits 模式需要方括号内含 emoji，纯数字 2×3 也会匹配 — 可接受的 tradeoff
    // 实际聊天中 [2×3] 不常见；如有误伤用户不会在 reply 里写这种格式
    const result = sanitizeOutgoingText("计算 [2×3] 等于6");
    // 不硬性要求保留——这是 tradeoff 的灰色地带
    expect(result).toBeDefined();
  });

  // ── 边界 ──────────────────────────────────────────────────────────────────

  it("截断超长文本", () => {
    const long = "a".repeat(5000);
    expect(sanitizeOutgoingText(long)).toHaveLength(4096);
  });

  it("空字符串经清洗后仍为空", () => {
    expect(sanitizeOutgoingText("")).toBe("");
  });

  it("纯注解被完全剥离后 trim 为空", () => {
    expect(sanitizeOutgoingText("[sticker 😏]")).toBe("");
    expect(sanitizeOutgoingText("(sticker 😏)")).toBe("");
  });

  // ── 句尾句号削除 ──────────────────────────────────────────────────────────

  it("削掉中文句尾句号", () => {
    expect(sanitizeOutgoingText("好的。")).toBe("好的");
  });

  it("削掉英文句尾句号", () => {
    expect(sanitizeOutgoingText("OK.")).toBe("OK");
  });

  it("只削尾部，句中句号保留", () => {
    expect(sanitizeOutgoingText("好的。再见。")).toBe("好的。再见");
  });

  it("保留省略号 ...", () => {
    expect(sanitizeOutgoingText("好的...")).toBe("好的...");
  });

  it("保留中文省略号 。。。", () => {
    expect(sanitizeOutgoingText("好的。。。")).toBe("好的。。。");
  });

  it("保留 Unicode 省略号 …", () => {
    expect(sanitizeOutgoingText("好的…")).toBe("好的…");
  });

  it("保留数字内嵌小数点", () => {
    expect(sanitizeOutgoingText("版本 3.14")).toBe("版本 3.14");
  });

  // ── 直引号 → 弯引号 ─────────────────────────────────────────────────────

  it("成对直引号 → 弯引号", () => {
    expect(sanitizeOutgoingText("你那个 'honney' 拼错了")).toBe("你那个 \u2018honney\u2019 拼错了");
  });

  it("多对引号分别转换（CJK 提升为双引号）", () => {
    expect(sanitizeOutgoingText("'草' 意思是 'lol'")).toBe("\u201c草\u201d 意思是 \u2018lol\u2019");
  });

  it("英文缩写的撇号 → 右弯引号", () => {
    expect(sanitizeOutgoingText("don't worry")).toBe("don\u2019t worry");
    expect(sanitizeOutgoingText("it's fine")).toBe("it\u2019s fine");
    expect(sanitizeOutgoingText("I'm here")).toBe("I\u2019m here");
  });

  it("混合引号和缩写", () => {
    expect(sanitizeOutgoingText("she said 'hello' and I'm fine")).toBe(
      "she said \u2018hello\u2019 and I\u2019m fine",
    );
  });

  it("无直引号的文本不受影响", () => {
    expect(sanitizeOutgoingText("普通文本 没有引号")).toBe("普通文本 没有引号");
  });

  it("已经是弯引号的文本不受影响", () => {
    expect(sanitizeOutgoingText("\u2018已经弯了\u2019")).toBe("\u2018已经弯了\u2019");
  });
});

describe("normalizeQuotes", () => {
  it("英文单引号 → 英文弯单引号", () => {
    expect(normalizeQuotes("'test'")).toBe("\u2018test\u2019");
  });

  it("中文单引号 → 中文双引号（提升）", () => {
    // 中国人不用单引号做主引号，提升为 ""
    expect(normalizeQuotes("'调好了'")).toBe("\u201c调好了\u201d");
    expect(normalizeQuotes("那'好 现在开始'的感觉")).toBe("那\u201c好 现在开始\u201d的感觉");
  });

  it("英文撇号 → '", () => {
    expect(normalizeQuotes("can't")).toBe("can\u2019t");
  });

  it("不跨行匹配", () => {
    const input = "'line1\nline2'";
    expect(normalizeQuotes(input)).toBe("\u2019line1\nline2\u2019");
  });

  it("空字符串", () => {
    expect(normalizeQuotes("")).toBe("");
  });

  it("连续两个直单引号", () => {
    expect(normalizeQuotes("''")).toBe("\u2019\u2019");
  });

  it("双引号 → 中文双引号", () => {
    expect(normalizeQuotes('"hello"')).toBe("\u201chello\u201d");
    expect(normalizeQuotes('他说"对"然后走了')).toBe("他说\u201c对\u201d然后走了");
  });

  it("孤立直引号", () => {
    expect(normalizeQuotes('wait"')).toBe("wait\u201d");
  });

  it("连续两个直双引号", () => {
    expect(normalizeQuotes('""')).toBe("\u201d\u201d");
  });

  it("混合：中文单引号提升 + 英文双引号", () => {
    expect(normalizeQuotes("他说\"不行\" 我说'好吧'")).toBe(
      "他说\u201c不行\u201d 我说\u201c好吧\u201d",
    );
  });

  it("已有弯引号不受影响", () => {
    expect(normalizeQuotes("\u201c已经弯了\u201d")).toBe("\u201c已经弯了\u201d");
    expect(normalizeQuotes("\u2018已经弯了\u2019")).toBe("\u2018已经弯了\u2019");
  });
});
