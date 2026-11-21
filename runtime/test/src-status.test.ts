import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 生产里有什么，以 mechanisms/registry.ts 和 pressure/index.ts 的 PRODUCTION 为准；源码注释只写机制做什么、为什么。
 * "已在生产""进生产"这类状态句会和注册表、文档抢"现在怎样"的解释权，状态一变它们就过时。
 */
const STATUS = /进了?生产|已在生产|不在生产/;

function statusLines(source: string): number[] {
  return source.split("\n").flatMap((line, i) => (STATUS.test(line) ? [i + 1] : []));
}

describe("source comments do not say what is in production", () => {
  it("no file under src/ carries a production-status sentence", () => {
    const hits = (readdirSync("src", { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        statusLines(readFileSync(join("src", f), "utf8")).map((n) => `src/${f}:${n}`),
      );
    expect(hits).toEqual([]);
  });

  it("the check itself catches the status words", () => {
    const sample = [
      "（已在生产）",
      "2026-11-14 进生产",
      "还没进生产",
      "进了生产",
      "不在生产",
      "生产组",
    ];
    expect(statusLines(sample.join("\n"))).toEqual([1, 2, 3, 4, 5]);
  });
});
