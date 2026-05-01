import { describe, expect, it, vi } from "vitest";

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

type ExecFileOptions = Parameters<typeof import("node:child_process").execFile>[2];

function dockerExecEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const sessionIdx = args.findIndex((arg) => arg.startsWith("alice-sbx-"));
  const end = sessionIdx >= 0 ? sessionIdx : args.length;

  for (let i = 1; i < end; i++) {
    if (args[i] !== "-e") continue;
    const assignment = args[i + 1] ?? "";
    const eq = assignment.indexOf("=");
    if (eq > 0) {
      env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    }
    i++;
  }

  return env;
}

// 拦截 Docker 调用：替换 executeInContainer 中的 execFile("docker", ...)
// 用真实 /bin/sh 执行脚本（测试关注的是 sentinel 解析和 thinks 提取逻辑，不是容器隔离本身）
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: vi.fn((cmd: string, args: string[], opts: ExecFileOptions, cb: ExecFileCallback) => {
      if (cmd === "docker") {
        const sub = args[0]; // docker subcommand: exec, create, start, inspect, rm ...
        if (sub === "exec") {
          // docker exec ... /bin/sh -c <script> — 提取脚本并用真实 sh 执行
          const shIdx = args.indexOf("/bin/sh");
          const script = shIdx >= 0 ? args[shIdx + 2] : args[args.length - 1];
          return original.execFile(
            "/bin/sh",
            ["-c", script],
            { ...opts, env: { ...process.env, ...dockerExecEnv(args) } },
            cb,
          );
        }
        // create / start / inspect / rm — 返回成功空输出
        cb(null, "", "");
        return;
      }
      return original.execFile(cmd, args, opts, cb);
    }),
  };
});

// 必须在 vi.mock 之后动态导入
const { executeShellScript } = await import("../src/core/shell-executor.js");

describe("executeShellScript", () => {
  // ADR-213: CONTROL_PREFIX 解析已移除。流控信号通过 tool calling flow 参数传递。

  it("filters ACTION_PREFIX lines from visible logs", async () => {
    const result = await executeShellScript(
      'printf "__ALICE_ACTION__:send_message\\n"\nprintf "visible\\n"',
      {},
    );

    expect(result.completedActions).toEqual(["send_message"]);
    expect(result.logs).toEqual(["visible"]);
    expect(result.errors).toEqual([]);
  });

  it("captures ERROR_PREFIX lines as structured error codes", async () => {
    const result = await executeShellScript(
      'printf "__ALICE_ERROR__:command_invalid_target\\n" >&2\nprintf "visible error\\n" >&2\nexit 1',
      {},
    );

    expect(result.errorCodes).toEqual(["command_invalid_target"]);
    expect(result.errors).toEqual(["visible error"]);
  });

  it("captures ERROR_DETAIL_PREFIX lines as structured error details", async () => {
    const detail = {
      code: "command_cross_chat_send",
      source: "irc.reply",
      currentChatId: "-1001",
      requestedChatId: "-1002",
      payload: { replyTo: 9 },
    };
    const result = await executeShellScript(
      `printf "__ALICE_ERROR__:command_cross_chat_send\\n" >&2\nprintf "__ALICE_ERROR_DETAIL__:%s\\n" '${JSON.stringify(detail)}' >&2\nprintf "refusing cross-chat send\\n" >&2\nexit 1`,
      {},
    );

    expect(result.errorCodes).toEqual(["command_cross_chat_send"]);
    expect(result.errorDetails).toEqual([detail]);
    expect(result.errors).toEqual(["refusing cross-chat send"]);
  });

  it("parses OBSERVATION_PREFIX lines into structured observations", async () => {
    const observation = {
      kind: "new_message_context",
      source: "irc.tail",
      text: '1. (msgId 10) 小T: "Alice 你怎么看？"',
      enablesContinuation: true,
    };
    const result = await executeShellScript(
      `printf "__ALICE_OBSERVATION__:%s\\n" '${JSON.stringify(observation)}'\nprintf "visible\\n"`,
      {},
    );

    expect(result.observations).toEqual([observation]);
    expect(result.logs).toEqual(["visible"]);
    expect(result.instructionErrors).toEqual([]);
  });

  it("reports invalid OBSERVATION_PREFIX lines instead of accepting them silently", async () => {
    const result = await executeShellScript(
      'printf "__ALICE_OBSERVATION__:{\\"kind\\":\\"read_ack\\",\\"source\\":\\"irc.read\\"}\\n"\nprintf "visible\\n"',
      {},
    );

    expect(result.observations).toEqual([]);
    expect(result.logs).toEqual(["visible"]);
    expect(result.instructionErrors[0]).toContain("invalid __ALICE_OBSERVATION__");
  });

  it("extracts # comments as thinks (cognitive trace)", async () => {
    const result = await executeShellScript(
      '#!/bin/sh\n# 他好久没联系了\n# 先试探一下\necho "hello"',
      {},
    );

    expect(result.thinks).toEqual(["他好久没联系了", "先试探一下"]);
    expect(result.logs).toEqual(["hello"]);
  });

  it("strips leaked sh language label before validation", async () => {
    const result = await executeShellScript("sh\n# 想一下\necho hello", {});

    expect(result.thinks).toEqual(["想一下"]);
    expect(result.logs).toEqual(["hello"]);
    expect(result.instructionErrors).toEqual([]);
  });

  it("surfaces shell failures as script errors", async () => {
    const result = await executeShellScript("echo boom >&2\nexit 2", {});
    expect(result.errors[0]).toContain("boom");
  });

  it("stops after a failed command before later side effects", async () => {
    const result = await executeShellScript('false\nprintf "should-not-run\\n"', {});

    expect(result.logs).toEqual([]);
    expect(result.errors).toEqual(["Shell exited with status 1"]);
  });

  it("returns instruction errors before entering the container for invalid scripts", async () => {
    const result = await executeShellScript("slef feel --valence positive", {});

    expect(result.instructionErrors).toEqual([
      "line 1: unknown command 'slef', did you mean 'self'?",
    ]);
    expect(result.logs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("strips garbled ANSI fragments and invisible noise from logs", async () => {
    const zws = "\u200b";
    const result = await executeShellScript(
      `printf "\\033[4m\\033[1mhello\\033[22m\\033[24m\\n[4m[1mworld[22m[24m\\nfoo${zws}bar\\n"`,
      {},
    );

    expect(result.logs).toEqual(["hello", "world", "foobar"]);
    expect(result.errors).toEqual([]);
  });

  it("passes execution context variables into the shell environment", async () => {
    const result = await executeShellScript('printf "%s\\n" "$ALICE_CTX_SOCIAL_CASE_0_HANDLE"', {
      contextVars: { SOCIAL_CASE_0_HANDLE: "firm-repair" },
    });

    expect(result.logs).toEqual(["firm-repair"]);
    expect(result.errors).toEqual([]);
  });
});
