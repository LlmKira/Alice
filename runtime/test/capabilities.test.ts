import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allMechanisms, mechanisms } from "../src/mechanisms/registry.js";
import { affordances } from "../src/mind/affordances.js";

/**
 * 能力账本（capabilities.md）是系统范围的唯一事实来源。重写时缺失不会自己报错，
 * 所以这里把账本和代码里的 affordance、机制对齐：代码里有而账本里没有、账本说已移植而代码里没有，都失败。
 */

const LEDGER = "capabilities.md";
const STATUSES = ["已移植", "简化移植", "刻意不做", "未做"] as const;
type Status = (typeof STATUSES)[number];

const MAIN_HEADER = ["#", "能力", "来源", "状态", "代码", "测试", "说明"];
const INVENTORY_HEADER = ["代码", "生产", "条目"];
const LOG_HEADER = ["日志", "类型", "条数", "条目"];

interface Table {
  header: string[];
  rows: string[][];
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Markdown 表格：表头、分隔行、数据行。 */
function tables(markdown: string): Table[] {
  const out: Table[] = [];
  let current: Table | null = null;
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) {
      current = null;
      continue;
    }
    const row = cells(line);
    if (current === null) {
      current = { header: row, rows: [] };
      out.push(current);
    } else if (!row.every((c) => /^:?-+:?$/.test(c))) {
      current.rows.push(row);
    }
  }
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const rowsOf = (all: Table[], header: string[]) =>
  all.filter((t) => same(t.header, header)).flatMap((t) => t.rows);

interface Ref {
  space: "affordance" | "mechanism" | "file";
  name: string;
}

function refs(cell: string): Ref[] {
  return Array.from(cell.matchAll(/`(affordance|mechanism|file):([^`]+)`/g), (m) => ({
    space: m[1] as Ref["space"],
    name: m[2] as string,
  }));
}

const testRefs = (cell: string) =>
  Array.from(cell.matchAll(/`(test\/[^`]+\.test\.ts)`/g), (m) => m[1] ?? "");
const ids = (cell: string) => cell.match(/\b[A-Z]\d{2}\b/g) ?? [];

const kinds = new Set<string>(affordances.map((a) => a.kind));
const names = new Set(allMechanisms.map((m) => m.name));
const production = new Set(mechanisms.map((m) => m.name));
/** 要机制提供的能力（心里的事、交出去办的事）只在提供它的机制在生产注册表里时才在生产路径上。 */
const provided = new Set<string>(mechanisms.flatMap((m) => m.affordances ?? []));
const offered = new Set(
  affordances.filter((a) => !a.gated || provided.has(a.kind)).map((a) => a.kind as string),
);

function exists(ref: Ref): boolean {
  if (ref.space === "affordance") return kinds.has(ref.name);
  if (ref.space === "mechanism") return names.has(ref.name);
  return existsSync(ref.name);
}

const show = (ref: Ref) => `${ref.space}:${ref.name}`;

interface Entry {
  id: string;
  status: string;
  code: Ref[];
  tests: string[];
  note: string;
}

const hasLedger = existsSync(LEDGER);
const parsed = hasLedger ? tables(readFileSync(LEDGER, "utf8")) : [];
const entries: Entry[] = rowsOf(parsed, MAIN_HEADER).map((r) => ({
  id: r[0] ?? "",
  status: r[3] ?? "",
  code: refs(r[4] ?? ""),
  tests: testRefs(r[5] ?? ""),
  note: r[6] ?? "",
}));
const inventory = rowsOf(parsed, INVENTORY_HEADER).map((r) => ({
  code: refs(r[0] ?? ""),
  production: r[1] ?? "",
  ids: ids(r[2] ?? ""),
}));
const logRows = rowsOf(parsed, LOG_HEADER);
const entryIds = new Set(entries.map((e) => e.id));

const withStatus = (status: Status) => entries.filter((e) => e.status === status);

describe.skipIf(!hasLedger)("capability ledger", () => {
  it("has entries, each with a unique id and one of the four statuses", () => {
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.filter((e) => !/^[A-Z]\d{2}$/.test(e.id)).map((e) => e.id)).toEqual([]);
    expect(entryIds.size).toBe(entries.length);
    expect(entries.filter((e) => !STATUSES.includes(e.status as Status)).map((e) => e.id)).toEqual(
      [],
    );
  });

  it("lists every registered affordance and every mechanism in the code inventory", () => {
    const listed = new Set(inventory.flatMap((r) => r.code.map(show)));
    const missing = [
      ...Array.from(kinds, (k) => `affordance:${k}`),
      ...Array.from(names, (n) => `mechanism:${n}`),
    ].filter((r) => !listed.has(r));
    expect(missing).toEqual([]);
  });

  it("marks exactly the production registry as in production", () => {
    const wrong = inventory.flatMap((r) =>
      r.code
        .filter((ref) => {
          const inProduction =
            ref.space === "affordance" ? offered.has(ref.name) : production.has(ref.name);
          return (r.production === "是") !== inProduction;
        })
        .map((ref) => `${show(ref)} (${r.production})`),
    );
    expect(wrong).toEqual([]);
    expect(inventory.filter((r) => !["是", "对照", "候选"].includes(r.production))).toEqual([]);
  });

  it("names only code that exists", () => {
    const all = [...entries.flatMap((e) => e.code), ...inventory.flatMap((r) => r.code)];
    expect(all.filter((ref) => !exists(ref)).map(show)).toEqual([]);
  });

  it("backs every 已移植 entry with production code and an existing test", () => {
    const broken = withStatus("已移植").flatMap((e) => {
      const why: string[] = [];
      if (e.code.length === 0) why.push("no code");
      if (e.tests.length === 0) why.push("no test");
      for (const t of e.tests) if (!existsSync(t)) why.push(`missing ${t}`);
      for (const ref of e.code) {
        if (ref.space === "mechanism" && !production.has(ref.name)) {
          why.push(`${show(ref)} is not in production`);
        }
        if (ref.space === "affordance" && !offered.has(ref.name)) {
          why.push(`${show(ref)} is not offered in production`);
        }
      }
      return why.map((w) => `${e.id}: ${w}`);
    });
    expect(broken).toEqual([]);
  });

  it("says what is missing, why it is left out, or when it is due", () => {
    const vague = [
      ...withStatus("简化移植").filter((e) => e.note.length === 0),
      // 刻意不做要有研究员同意的记录，否则只能算未做。
      ...withStatus("刻意不做").filter((e) => !e.note.includes("研究员")),
      ...withStatus("未做").filter((e) => !e.note.includes("阶段")),
    ].map((e) => `${e.id} ${e.status}`);
    expect(vague).toEqual([]);
  });

  it("points the inventory and the old-log table only at entries that exist", () => {
    const dangling = [
      ...inventory.flatMap((r) => r.ids),
      ...logRows.flatMap((r) => ids(r[3] ?? "")),
    ].filter((id) => !entryIds.has(id));
    expect(dangling).toEqual([]);
    expect(logRows.length).toBeGreaterThan(30);
  });
});
