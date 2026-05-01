import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TABLE_CLASSIFICATIONS } from "../src/db/schema-classification.js";

const schemaPath = fileURLToPath(new URL("../src/db/schema.ts", import.meta.url));
const schemaSource = readFileSync(schemaPath, "utf8");

function exportedSqliteTables(): string[] {
  return [...schemaSource.matchAll(/export const (\w+) = sqliteTable\(/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

describe("schema classification registry", () => {
  it("classifies every sqliteTable export", () => {
    const exports = exportedSqliteTables();
    expect(exports.length).toBeGreaterThan(0);
    expect(Object.keys(TABLE_CLASSIFICATIONS).sort()).toEqual(exports.sort());
  });

  it("keeps audit facts append-only and away from control readers", () => {
    for (const entry of Object.values(TABLE_CLASSIFICATIONS)) {
      if (entry.class !== "audit_fact") continue;
      expect(entry.appendOnly).toBe(true);
      expect(entry.readers.toLowerCase()).not.toMatch(/gate|pressure|selection/);
    }
  });
});
