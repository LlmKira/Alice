#!/usr/bin/env tsx
/**
 * Contact profile health audit.
 *
 * Read-only SQLite probe for the North Star contact-profile / impression loop.
 * It does not import runtime DB connection code, so it cannot run migrations.
 *
 * Usage:
 *   cd runtime && pnpm exec tsx scripts/contact-profile-health.ts
 *   cd runtime && pnpm exec tsx scripts/contact-profile-health.ts --since-action-id 2756 --json
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";

interface Args {
  dbPath: string;
  sinceActionId: number;
  recentLimit: number;
  json: boolean;
}

interface ModStateRow {
  state_json: string;
}

interface GraphNodeRow {
  attrs: string;
}

interface ActionLogRow {
  id: number;
  action_type: string | null;
  tc_command_log: string | null;
}

interface ContactProfile {
  activeHours?: number[];
  interests?: string[];
  lastUpdatedTick?: number;
  lastUpdatedMs?: number;
  portrait?: string | null;
  traits?: Record<string, unknown>;
  crystallizedInterests?: Record<string, unknown>;
}

interface BeliefEntry {
  mu?: number;
  sigma2?: number;
  tObs?: number;
}

interface Report {
  dbPath: string;
  sinceActionId: number;
  profiles: {
    total: number;
    canonicalKeys: number;
    legacyContactAtKeys: number;
    nonCanonicalKeys: string[];
    activeHourTotal: number;
    crystallizedTraits: number;
    crystallizedInterests: number;
    portraits: number;
  };
  beliefs: {
    traitOrInterestTotal: number;
    lowSigmaTotal: number;
    traitTotal: number;
    interestTotal: number;
    rows: Array<{ key: string; mu: number | null; sigma2: number | null; tObs: number | null }>;
  };
  actions: {
    maxActionId: number;
    noteActiveHour: number;
    selfSense: number;
    tagInterest: number;
    invalidTrait: number;
    recentRelevant: Array<{ id: number; actionType: string | null; summary: string }>;
  };
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reasons: string[];
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.dbPath, { readonly: true });
const report = buildReport(db, args);

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

function buildReport(db: Database.Database, args: Args): Report {
  const contactProfiles = readContactProfiles(db);
  const profileRows = Object.entries(contactProfiles);
  const beliefRows = readBeliefs(db);
  const maxActionId = scalarNumber(db, "SELECT max(id) FROM action_log");

  const actions = {
    maxActionId,
    noteActiveHour: countLike(db, args.sinceActionId, "%self note-active-hour%"),
    selfSense: countLike(db, args.sinceActionId, "%self sense%"),
    tagInterest: countLike(db, args.sinceActionId, "%self tag-interest%"),
    invalidTrait: countLike(db, args.sinceActionId, "%Invalid params: trait%"),
    recentRelevant: recentRelevantActions(db, args.sinceActionId, args.recentLimit),
  };

  const profiles = {
    total: profileRows.length,
    canonicalKeys: profileRows.filter(([key]) => key.startsWith("contact:")).length,
    legacyContactAtKeys: profileRows.filter(([key]) => /^@-?\d+$/.test(key)).length,
    nonCanonicalKeys: profileRows
      .map(([key]) => key)
      .filter((key) => !key.startsWith("contact:"))
      .sort(),
    activeHourTotal: round2(
      profileRows.reduce((sum, [, profile]) => sum + sumNumbers(profile.activeHours ?? []), 0),
    ),
    crystallizedTraits: profileRows.reduce(
      (sum, [, profile]) => sum + Object.keys(profile.traits ?? {}).length,
      0,
    ),
    crystallizedInterests: profileRows.reduce(
      (sum, [, profile]) => sum + Object.keys(profile.crystallizedInterests ?? {}).length,
      0,
    ),
    portraits: profileRows.filter(([, profile]) => profile.portrait != null).length,
  };

  const beliefs = {
    traitOrInterestTotal: beliefRows.length,
    lowSigmaTotal: beliefRows.filter((row) => row.sigma2 != null && row.sigma2 < 0.1).length,
    traitTotal: beliefRows.filter((row) => row.key.includes("::trait:")).length,
    interestTotal: beliefRows.filter((row) => row.key.includes("::interest:")).length,
    rows: beliefRows,
  };

  const reasons: string[] = [];
  if (profiles.legacyContactAtKeys > 0) {
    reasons.push(`legacy numeric @ profile keys remain: ${profiles.legacyContactAtKeys}`);
  }
  if (actions.selfSense === 0) reasons.push("no self sense actions observed since baseline");
  if (actions.tagInterest === 0) reasons.push("no self tag-interest actions observed since baseline");
  if (beliefs.traitOrInterestTotal === 0) reasons.push("no trait/interest beliefs found");
  if (profiles.crystallizedTraits + profiles.crystallizedInterests === 0) {
    reasons.push("no crystallized profile traits or interests yet");
  }
  if (actions.invalidTrait > 0) reasons.push(`invalid trait attempts observed: ${actions.invalidTrait}`);

  const verdict =
    actions.selfSense > 0 &&
    beliefs.traitTotal > 0 &&
    profiles.legacyContactAtKeys === 0 &&
    actions.invalidTrait === 0
      ? profiles.crystallizedTraits + profiles.crystallizedInterests > 0
        ? "PASS"
        : "INCONCLUSIVE"
      : "FAIL";

  return {
    dbPath: args.dbPath,
    sinceActionId: args.sinceActionId,
    profiles,
    beliefs,
    actions,
    verdict,
    reasons,
  };
}

function readContactProfiles(db: Database.Database): Record<string, ContactProfile> {
  const row = db
    .prepare("SELECT state_json FROM mod_states WHERE mod_name = 'relationships'")
    .get() as ModStateRow | undefined;
  if (!row) return {};
  const state = parseJsonObject(row.state_json);
  const profiles = state.contactProfiles;
  return isRecord(profiles) ? (profiles as Record<string, ContactProfile>) : {};
}

function readBeliefs(db: Database.Database): Report["beliefs"]["rows"] {
  const row = db
    .prepare("SELECT attrs FROM graph_nodes WHERE id = '__beliefs__'")
    .get() as GraphNodeRow | undefined;
  if (!row) return [];
  const attrs = parseJsonObject(row.attrs);
  const entries = isRecord(attrs.entries) ? attrs.entries : {};
  return Object.entries(entries)
    .filter(([key]) => key.includes("::trait:") || key.includes("::interest:"))
    .map(([key, value]) => {
      const entry = isRecord(value) ? (value as BeliefEntry) : {};
      return {
        key,
        mu: finiteNumberOrNull(entry.mu),
        sigma2: finiteNumberOrNull(entry.sigma2),
        tObs: finiteNumberOrNull(entry.tObs),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function countLike(db: Database.Database, sinceActionId: number, pattern: string): number {
  return scalarNumber(
    db,
    "SELECT count(*) FROM action_log WHERE id > ? AND tc_command_log LIKE ?",
    sinceActionId,
    pattern,
  );
}

function recentRelevantActions(
  db: Database.Database,
  sinceActionId: number,
  limit: number,
): Report["actions"]["recentRelevant"] {
  const rows = db
    .prepare(
      `SELECT id, action_type, tc_command_log
       FROM action_log
       WHERE id > ?
         AND (
           tc_command_log LIKE '%self sense%'
           OR tc_command_log LIKE '%self tag-interest%'
           OR tc_command_log LIKE '%self note-active-hour%'
           OR tc_command_log LIKE '%Invalid params: trait%'
         )
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(sinceActionId, limit) as ActionLogRow[];
  return rows.map((row) => ({
    id: row.id,
    actionType: row.action_type,
    summary: summarizeCommandLog(row.tc_command_log ?? ""),
  }));
}

function scalarNumber(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).raw().get(...params) as [unknown] | undefined;
  const n = Number(row?.[0] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function summarizeCommandLog(log: string): string {
  return log
    .replace(/\s+/g, " ")
    .replace(/"[^"]{80,}"/g, '"..."')
    .slice(0, 500);
}

function printReport(report: Report): void {
  console.log("===============================================================");
  console.log("  Contact Profile Health Audit");
  console.log("===============================================================");
  console.log(`DB:                ${report.dbPath}`);
  console.log(`Since action id:   ${report.sinceActionId}`);
  console.log(`Max action id:     ${report.actions.maxActionId}`);
  console.log();
  console.log("Profiles");
  console.log(`  total:                 ${report.profiles.total}`);
  console.log(`  canonical keys:        ${report.profiles.canonicalKeys}`);
  console.log(`  legacy numeric @ keys: ${report.profiles.legacyContactAtKeys}`);
  console.log(`  non-canonical keys:    ${report.profiles.nonCanonicalKeys.join(", ") || "(none)"}`);
  console.log(`  active hour total:     ${report.profiles.activeHourTotal}`);
  console.log(`  crystallized traits:   ${report.profiles.crystallizedTraits}`);
  console.log(`  crystallized interests:${report.profiles.crystallizedInterests}`);
  console.log(`  portraits:             ${report.profiles.portraits}`);
  console.log();
  console.log("Beliefs");
  console.log(`  trait/interest total:  ${report.beliefs.traitOrInterestTotal}`);
  console.log(`  low sigma (<0.1):      ${report.beliefs.lowSigmaTotal}`);
  console.log(`  trait beliefs:         ${report.beliefs.traitTotal}`);
  console.log(`  interest beliefs:      ${report.beliefs.interestTotal}`);
  for (const row of report.beliefs.rows) {
    console.log(`  - ${row.key} mu=${row.mu} sigma2=${row.sigma2} tObs=${row.tObs}`);
  }
  console.log();
  console.log("Actions");
  console.log(`  note-active-hour:      ${report.actions.noteActiveHour}`);
  console.log(`  self sense:            ${report.actions.selfSense}`);
  console.log(`  tag-interest:          ${report.actions.tagInterest}`);
  console.log(`  invalid trait:         ${report.actions.invalidTrait}`);
  for (const row of report.actions.recentRelevant) {
    console.log(`  - #${row.id} ${row.actionType ?? "(unknown)"} ${row.summary}`);
  }
  console.log();
  console.log(`Verdict: ${report.verdict}`);
  for (const reason of report.reasons) {
    console.log(`  - ${reason}`);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: resolve(import.meta.dirname ?? ".", "../alice.db"),
    sinceActionId: 0,
    recentLimit: 10,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next) {
      args.dbPath = resolve(process.cwd(), next);
      i++;
    } else if (arg === "--since-action-id" && next) {
      args.sinceActionId = Number(next);
      i++;
    } else if (arg === "--recent-limit" && next) {
      args.recentLimit = Number(next);
      i++;
    } else if (arg === "--json") {
      args.json = true;
    }
  }
  return args;
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => (Number.isFinite(value) ? sum + value : sum), 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
