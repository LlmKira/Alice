import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const dbPath = resolve(process.argv[2] ?? "alice.db");
if (!existsSync(dbPath)) {
  throw new Error(`DB not found: ${dbPath}`);
}

const LEGACY_CHANNEL_RE = /^channel:(-?\d+)$/u;
const LEGACY_CONTACT_RE = /^contact:(-?\d+)$/u;
const LEGACY_MESSAGE_RE = /^message:telegram:(-?\d+):([^:]+)$/u;

function normalizeEntityId(value: string): string {
  const channel = LEGACY_CHANNEL_RE.exec(value);
  if (channel) return `channel:telegram:${channel[1]}`;
  const contact = LEGACY_CONTACT_RE.exec(value);
  if (contact) return `contact:telegram:${contact[1]}`;
  const message = LEGACY_MESSAGE_RE.exec(value);
  if (message) return `message:telegram:${message[1]}:${message[2]}`;
  return value;
}

function normalizeDeep(value: unknown): unknown {
  if (typeof value === "string") return normalizeEntityId(value);
  if (Array.isArray(value)) return value.map(normalizeDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = normalizeDeep(item);
    }
    return out;
  }
  return value;
}

function normalizeJsonText(text: string | null): string | null {
  if (text == null || text.length === 0) return text;
  try {
    return JSON.stringify(normalizeDeep(JSON.parse(text)));
  } catch {
    return text;
  }
}

const db = new Database(dbPath);
db.pragma("foreign_keys = OFF");

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

const before = {
  graphNodes: count(
    "select count(*) as n from graph_nodes where id glob 'channel:[0-9-]*' or id glob 'contact:[0-9-]*'",
  ),
  graphEdges: count(
    "select count(*) as n from graph_edges where src glob 'channel:[0-9-]*' or src glob 'contact:[0-9-]*' or dst glob 'channel:[0-9-]*' or dst glob 'contact:[0-9-]*'",
  ),
  messageLog: count(
    "select count(*) as n from message_log where chat_id glob 'channel:[0-9-]*' or sender_id glob 'contact:[0-9-]*'",
  ),
  canonicalEvents: count(
    "select count(*) as n from canonical_events where channel_id glob 'channel:[0-9-]*' or contact_id glob 'contact:[0-9-]*'",
  ),
};

const clean = db.transaction(() => {
  const graphRows = db.prepare("select id, attrs from graph_nodes").all() as Array<{
    id: string;
    attrs: string;
  }>;
  const updateGraph = db.prepare("update graph_nodes set id = ?, attrs = ? where id = ?");
  for (const row of graphRows) {
    const nextId = normalizeEntityId(row.id);
    const nextAttrs = normalizeJsonText(row.attrs) ?? row.attrs;
    if (nextId !== row.id || nextAttrs !== row.attrs) {
      updateGraph.run(nextId, nextAttrs, row.id);
    }
  }

  const edgeRows = db.prepare("select id, src, dst, attrs from graph_edges").all() as Array<{
    id: number;
    src: string;
    dst: string;
    attrs: string | null;
  }>;
  const updateEdge = db.prepare("update graph_edges set src = ?, dst = ?, attrs = ? where id = ?");
  for (const row of edgeRows) {
    updateEdge.run(
      normalizeEntityId(row.src),
      normalizeEntityId(row.dst),
      normalizeJsonText(row.attrs),
      row.id,
    );
  }

  db.prepare(
    "update message_log set chat_id = 'channel:telegram:' || substr(chat_id, 9) where chat_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update message_log set sender_id = 'contact:telegram:' || substr(sender_id, 9) where sender_id glob 'contact:[0-9-]*'",
  ).run();
  db.prepare(
    "update canonical_events set channel_id = 'channel:telegram:' || substr(channel_id, 9) where channel_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update canonical_events set contact_id = 'contact:telegram:' || substr(contact_id, 9) where contact_id glob 'contact:[0-9-]*'",
  ).run();
  db.prepare(
    "update action_log set target = 'channel:telegram:' || substr(target, 9) where target glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update action_log set chat_id = 'channel:telegram:' || substr(chat_id, 9) where chat_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update silence_log set target = 'channel:telegram:' || substr(target, 9) where target glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update deferred_outcome_log set channel_id = 'channel:telegram:' || substr(channel_id, 9) where channel_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update intervention_outcome_evidence set channel_id = 'channel:telegram:' || substr(channel_id, 9) where channel_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update rhythm_profiles set entity_id = 'channel:telegram:' || substr(entity_id, 9) where entity_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update rhythm_profiles set entity_id = 'contact:telegram:' || substr(entity_id, 9) where entity_id glob 'contact:[0-9-]*'",
  ).run();
  db.prepare(
    "update diary_entries set about = 'channel:telegram:' || substr(about, 9) where about glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update diary_entries set about = 'contact:telegram:' || substr(about, 9) where about glob 'contact:[0-9-]*'",
  ).run();
  db.prepare(
    "update bio_cache set entity_id = 'channel:telegram:' || substr(entity_id, 9) where entity_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update bio_cache set entity_id = 'contact:telegram:' || substr(entity_id, 9) where entity_id glob 'contact:[0-9-]*'",
  ).run();
  db.prepare(
    "update sticker_usage set chat_id = 'channel:telegram:' || substr(chat_id, 9) where chat_id glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update scheduled_tasks set target = 'channel:telegram:' || substr(target, 9) where target glob 'channel:[0-9-]*'",
  ).run();
  db.prepare(
    "update episodes set target = 'channel:telegram:' || substr(target, 9) where target glob 'channel:[0-9-]*'",
  ).run();

  const jsonTables: Array<[string, string, string]> = [
    ["canonical_events", "id", "payload_json"],
    ["decision_trace", "id", "payload_json"],
    ["candidate_trace", "id", "normalized_considerations_json"],
    ["queue_trace", "id", "reason_code"],
    ["action_result", "id", "completed_action_refs_json"],
    ["action_result", "id", "execution_observations_json"],
    ["focus_transition_shadow", "id", "payload_json"],
    ["focus_transition_intent", "id", "payload_json"],
    ["social_events", "id", "witnesses_json"],
    ["social_events", "id", "evidence_msg_ids_json"],
    ["social_events", "id", "causes_json"],
    ["episodes", "id", "entity_ids"],
  ];
  for (const [table, pk, column] of jsonTables) {
    const rows = db.prepare(`select ${pk} as pk, ${column} as value from ${table}`).all() as Array<{
      pk: string | number;
      value: string | null;
    }>;
    const update = db.prepare(`update ${table} set ${column} = ? where ${pk} = ?`);
    for (const row of rows) {
      const next = normalizeJsonText(row.value);
      if (next !== row.value) update.run(next, row.pk);
    }
  }
});

clean();

const after = {
  graphNodes: count(
    "select count(*) as n from graph_nodes where id glob 'channel:[0-9-]*' or id glob 'contact:[0-9-]*'",
  ),
  graphEdges: count(
    "select count(*) as n from graph_edges where src glob 'channel:[0-9-]*' or src glob 'contact:[0-9-]*' or dst glob 'channel:[0-9-]*' or dst glob 'contact:[0-9-]*'",
  ),
  messageLog: count(
    "select count(*) as n from message_log where chat_id glob 'channel:[0-9-]*' or sender_id glob 'contact:[0-9-]*'",
  ),
  canonicalEvents: count(
    "select count(*) as n from canonical_events where channel_id glob 'channel:[0-9-]*' or contact_id glob 'contact:[0-9-]*'",
  ),
};

db.prepare(
  "insert into audit_events (tick, level, source, message, details, created_at) values (0, 'warn', 'db-cleanup', 'normalized graph ids to platform-qualified form', ?, unixepoch())",
).run(JSON.stringify({ before, after }));

db.pragma("foreign_keys = ON");
db.close();

console.log(JSON.stringify({ dbPath, before, after }, null, 2));
