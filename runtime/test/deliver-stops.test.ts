/**
 * 一个动作自己的失败不吞掉同一轮的话：只有"这个会话此刻发不出去"的失败才跳过后面的动作。
 * 线上一个限定了表情的群里，三次决定都是表情在前、话在后，表情被拒（invalid_reaction），后面的话和贴纸全被跳过
 * （eval-artifacts/footprint/）。
 */
import { describe, expect, it } from "vitest";
import { type ActEffect, type DeliveryPorts, deliver } from "../src/interpret.js";
import type { Act } from "../src/mind/affordances.js";
import type { AliceEvent } from "../src/mind/events.js";
import { Failed, type FailureCode } from "../src/mind/failure.js";

const G = "telegram:-1009";

async function run(failing: Act["kind"], reason: Exclude<FailureCode, "errand">) {
  const events: AliceEvent[] = [];
  let id = 900;
  const ports: DeliveryPorts = {
    now: () => 1_000,
    emit: (e) => void events.push(e),
    act: async (_scope, act) => {
      if (act.kind === failing) throw new Failed({ reason });
      return act.kind === "send" ? { kind: "posted", messageId: String(id++) } : { kind: "done" };
    },
    timeline: () => [],
  };
  const batch: ActEffect[] = [
    { type: "act", scope: G, act: { kind: "react", messageId: "5", emoji: "👀" } },
    { type: "act", scope: G, act: { kind: "send", text: "你好", replyTo: null } },
  ];
  await deliver(batch, ports);
  return events.map((e) => (e.type === "act.failed" ? `failed:${e.reason}` : e.type));
}

describe("一个动作自己的失败不吞掉同一轮的话", () => {
  it("对照：这个会话此刻发不出去（没权限），后面的话也不发", async () => {
    expect(await run("react", "transport_soft_permanent")).toEqual([
      "failed:transport_soft_permanent",
      "failed:skipped_after_failure",
    ]);
  });

  it("表情在这里用不了：话照样发出去", async () => {
    expect(await run("react", "invalid_reaction")).toEqual([
      "failed:invalid_reaction",
      "message.sent",
    ]);
  });
});
