/**
 * 脚本预验证单元测试。
 *
 * @see src/core/script-validator.ts
 * @see docs/adr/211-instructor-js-script-prevalidation.md
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  registerKnownCommands,
  registerKnownSubcommands,
  resetKnownCommands,
  validateScript,
} from "../src/core/script-validator.js";

afterEach(() => {
  resetKnownCommands();
});

describe("validateScript", () => {
  // ── bash -n 语法检查 ────────────────────────────────────────────────

  it("有效脚本 → valid", () => {
    const result = validateScript('# 思考\nirc say --text "hello"');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("语法错误 → 报告行号", () => {
    const result = validateScript("if true\necho yes");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("syntax error"))).toBe(true);
  });

  it("纯注释脚本 → invalid（无可执行命令）", () => {
    const result = validateScript("# 只有注释\n# 没有命令");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("no executable commands");
  });

  it("LLM 输出纯自然语言 → invalid", () => {
    const result = validateScript("好的我来看看这个群的情况，让我想想该说什么");
    expect(result.valid).toBe(false);
    // 要么被 bash -n 拦截，要么被命令名校验拦截
  });

  // ── 命令名校验 ──────────────────────────────────────────────────────

  it("已知命令 → valid", () => {
    const result = validateScript('irc say --text "hello"\nself feel --valence positive');
    expect(result.valid).toBe(true);
  });

  it("接受双引号参数里的真实多行文本", () => {
    const result = validateScript(
      'irc reply --ref 130199 --text "好哦 那讲个短的\n\n从前有颗星星\n晚安"\nself feel --valence positive',
    );
    expect(result.valid).toBe(true);
  });

  it("未知命令 → 报错", () => {
    const result = validateScript("unknowncmd hello");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("unknown command");
  });

  it("变量赋值 → 跳过（不是命令）", () => {
    const result = validateScript('recent=$(irc tail --count 5)\nirc say --text "hello"');
    expect(result.valid).toBe(true);
  });

  it("拒绝 #latest 这类虚构消息引用", () => {
    const result = validateScript("irc react --ref #latest --emoji 👀");
    expect(result.valid).toBe(false);
    expect(result.summary).toContain("never latest");
  });

  it("拒绝裸 # 数字消息引用，避免 shell 注释吞掉后续参数", () => {
    const result = validateScript('irc reply --ref #12099 --text "hello"');
    expect(result.valid).toBe(false);
    expect(result.summary).toContain("starts a shell comment");
  });

  it("接受数字消息引用", () => {
    const result = validateScript('irc reply --ref 12099 --text "hello"');
    expect(result.valid).toBe(true);
  });

  it("拒绝用 shell 变量作为消息引用", () => {
    const result = validateScript(
      'msg_id=$(irc tail --count 1)\nirc react --ref "$msg_id" --emoji 👀',
    );
    expect(result.valid).toBe(false);
    expect(result.summary).toContain("--ref must be a literal visible msgId");
  });

  it("shell 关键字 → 跳过", () => {
    registerKnownCommands(["echo"]);
    const result = validateScript("if true; then\n  echo yes\nfi");
    expect(result.valid).toBe(true);
  });

  // ── 模糊匹配 ────────────────────────────────────────────────────────

  it("顶级命令拼写错误 → did you mean 建议", () => {
    const result2 = validateScript("slef feel valence=positive");
    expect(result2.valid).toBe(false);
    expect(result2.errors[0].message).toContain("did you mean 'self'");
  });

  it("完全不相关的命令 → 无建议", () => {
    const result = validateScript("xyzzyplugh hello");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).not.toContain("did you mean");
  });

  it("注册子命令后拒绝不存在的 self 子命令", () => {
    registerKnownSubcommands("self", ["feel", "note", "diary"]);

    const result = validateScript("self read --in @room --count 5");

    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("unknown_subcommand");
    expect(result.summary).toContain("unknown self subcommand 'read'");
  });

  it("注册子命令后拒绝不存在的 irc 子命令", () => {
    registerKnownSubcommands("irc", ["read", "tail", "whois"]);

    const result = validateScript("irc unblock --target Replies");

    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("unknown_subcommand");
    expect(result.summary).toContain("unknown irc subcommand 'unblock'");
  });

  // ── registerKnownCommands ───────────────────────────────────────────

  it("注册自定义命令后可通过验证", () => {
    const before = validateScript("my-custom-skill run");
    expect(before.valid).toBe(false);

    registerKnownCommands(["my-custom-skill"]);
    const after = validateScript("my-custom-skill run");
    expect(after.valid).toBe(true);
  });

  // ── summary 格式 ────────────────────────────────────────────────────

  it("summary 包含行号和错误信息", () => {
    const result = validateScript("# 思考\nslef feel\nirc say hi");
    expect(result.summary).toContain("line 2:");
    expect(result.summary).toContain("slef");
  });
});
