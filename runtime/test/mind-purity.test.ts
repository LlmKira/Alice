import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 心智核心和机制插件必须是纯函数：一旦读时钟、取随机数或做 I/O，回放就不再确定。 */
const PURE_DIRS = ["src/mind", "src/mechanisms", "src/mechanisms/pressure", "src/speech"];
const FORBIDDEN: Array<[RegExp, string]> = [
  [/Date\.now\(|new Date\(/, "reads the clock"],
  [/Math\.random\(/, "uses randomness"],
  [/from "node:/, "imports a Node built-in"],
  [/from "better-sqlite3"|from "\.\.\/db\/|from "\.\.\/journal/, "touches storage"],
  [/\bfetch\(|process\.env/, "reaches outside"],
];

function impurities(source: string): string[] {
  return FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, why]) => why);
}

describe("purity of the mind core", () => {
  for (const dir of PURE_DIRS) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      it(`${dir}/${file} is pure`, () => {
        expect(impurities(readFileSync(join(dir, file), "utf8"))).toEqual([]);
      });
    }
  }

  it("the check itself catches an impure file", () => {
    expect(impurities('const now = Date.now();\nimport { x } from "node:fs";')).toEqual([
      "reads the clock",
      "imports a Node built-in",
    ]);
  });
});
