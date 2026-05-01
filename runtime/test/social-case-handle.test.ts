import { describe, expect, it } from "vitest";
import { makeSocialCaseHandle } from "../src/social-case/index.js";

describe("ADR-262 prompt-visible social case handles", () => {
  it("derives stable human-copyable handles without exposing internal case ids", () => {
    const handle = makeSocialCaseHandle({
      caseId: "social-case:4f72c318b6d9d0aa",
      about: "A / insult in 技术群",
    });

    expect(handle).toMatch(/^[a-z]+-[a-z]+(?:-[a-z]+)?$/);
    expect(handle).toBe(
      makeSocialCaseHandle({
        caseId: "social-case:4f72c318b6d9d0aa",
        about: "A / insult in 技术群",
      }),
    );
    expect(handle).not.toContain("social-case");
    expect(handle).not.toContain("4f72");
  });

  it("uses a salted phrase when a prompt already used the first handle", () => {
    const first = makeSocialCaseHandle({
      caseId: "social-case:collision",
      about: "A / insult in 技术群",
    });
    const second = makeSocialCaseHandle({
      caseId: "social-case:collision",
      about: "A / insult in 技术群",
      usedHandles: new Set([first]),
    });

    expect(second).not.toBe(first);
    expect(second).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });
});
