import { describe, expect, it } from "vitest";
import { buildShellGuide } from "../src/engine/act/shell-guide.js";

describe("buildShellGuide", () => {
  it("all chat guides state the current-chat active-send contract", () => {
    for (const chatTargetType of [
      "private_person",
      "private_bot",
      "group",
      "channel_other",
      "channel_owned",
    ] as const) {
      const guide = buildShellGuide({ chatTargetType });

      expect(guide).toContain("This episode has one active chat");
      expect(guide).toContain("Do not use `--in` to send into another chat");
      expect(guide).toContain("self attention-pull --to");
      expect(guide).toContain("self switch-chat --to");
      expect(guide).toContain("You are still here; no message is sent there");
      expect(guide).toContain("use `irc forward");
    }
  });

  it("bot guide treats bots as tool sessions rather than social partners", () => {
    const guide = buildShellGuide({ chatTargetType: "private_bot" });

    expect(guide).toContain("tool session, not a social relationship");
    expect(guide).toContain("Bots don't have feelings");
    expect(guide).toContain("only accepts buttons, stop");
  });

  it("private chat guide keeps remembered facts anchored", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    expect(guide).toContain("When you mention a remembered fact");
    expect(guide).toContain('don\'t turn a guess into "I remember"');
  });

  it("private chat guide shows low-friction impression recording", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    expect(guide).toContain("quietly forming an impression");
    expect(guide).toContain("self sense --trait gentle --intensity moderate");
  });

  it("group chat guide keeps remembered facts anchored", () => {
    const guide = buildShellGuide({ chatTargetType: "group" });

    expect(guide).toContain("When you mention a remembered fact");
    expect(guide).toContain('don\'t turn a guess into "I remember"');
  });

  it("prefers batched observe-then-act group examples when tags are cautious and observing", () => {
    const guide = buildShellGuide({
      chatTargetType: "group",
      facetTags: ["cautious", "observing", "engaged"],
      hasBots: false,
    });

    const batchedTitle = "need a beat to catch up — read first, then chime in once";
    const contextOnlyTitle = "dropped into an unfamiliar group — look before you leap";

    expect(guide).toContain(batchedTitle);
    expect(guide).toContain("irc tail --count 8");
    expect(guide).toContain('irc reply --ref 3390931 --text "我也是这么觉得 前面那句太好笑了"');
    expect(guide).toContain("irc read");
    expect(guide).toContain("batch the pure reads into one script first");

    expect(guide.indexOf(batchedTitle)).toBeGreaterThan(-1);
    expect(guide.indexOf(contextOnlyTitle)).toBeGreaterThan(-1);
    expect(guide.indexOf(batchedTitle)).toBeLessThan(guide.indexOf(contextOnlyTitle));
  });

  it("uses valid self sense trait examples", () => {
    const guide = buildShellGuide({ chatTargetType: "group" });

    expect(guide).toContain("self sense --who @789012 --trait kind --intensity moderate");
    expect(guide).not.toContain("--trait helpful");
  });
});
